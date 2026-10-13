import {CRYPTO_MARKETS,findCrypto} from './crypto-catalog.js';
import {findProviderGaps,mergeProviderGapBars,shouldAttemptGap} from './market-gap-recovery.js';

/**
 * Provider-authoritative, read-only historical backfill. A single same-origin
 * request is limited to 300 candles by the PHP/Rust gateway. The client pages
 * older candles using exclusive UTC-second cursors, never price interpolation.
 *
 * 15m * 1000 completed candles need ~15001 1m bars plus alignment margin.
 * This bound covers the largest Wick Science input without unlimited memory,
 * provider requests or an arbitrary public-history proxy.
 */
export const MAX_AUTO_BACKFILL_BARS=15016;
export const INITIAL_BACKFILL_BARS=1600;
const PAGE_BARS=300;
const PAGE_LIMIT=Math.ceil(MAX_AUTO_BACKFILL_BARS/PAGE_BARS)+2;
const INTERVALS=new Set(['1m','5m','15m','1h','1d']);
const SECONDS=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});

function pageIdentity(req,listing){
  return listing.exchange+':'+listing.market+':'+listing.symbol+':'+req.interval;
}
function validBars(rows,req,max){
  if(!Array.isArray(rows)||rows.length>max)throw Error('Invalid history page size');
  let prev=0;
  for(const b of rows){
    if(!Number.isSafeInteger(b.time)||b.time<=prev||b.time%SECONDS[req.interval]!==0 ||
      !['open','high','low','close','volume'].every(k=>Number.isFinite(b[k])) ||
      b.open<=0||b.close<=0||b.low<=0||b.high<Math.max(b.open,b.close)||
      b.low>Math.min(b.open,b.close)||b.volume<0)
      throw Error('Invalid exchange candle');
    prev=b.time;
  }
  return rows;
}
function safeBefore(before,interval){
  if(!Number.isSafeInteger(before)||before<1500000000||
      before>Date.now()/1000+SECONDS[interval] ||before%SECONDS[interval]!==0)
    throw Error('Invalid historical cursor');
  return before;
}
export class QsynCryptoFeed {
  constructor(onState=()=>{}) {
    this.onState=onState;
    this.closed=false;
    this.controllers=new Set();
    this.timers=new Set();
    this.historyTargets=new Map();
    this.gapAttempts=new Map();
  }
  setHistoryTarget(exchange,symbol,interval,bars){
    const listing=findCrypto(exchange,symbol);
    if(!listing||!INTERVALS.has(interval)||!Number.isSafeInteger(bars)||bars<1)return false;
    const key=pageIdentity({interval},listing);
    const value=Math.min(MAX_AUTO_BACKFILL_BARS,bars);
    if((this.historyTargets.get(key)||0)>=value)return false;
    this.historyTargets.set(key,value);
    return true;
  }
  async _page(req,listing,signal,limit,before){
    if(this.closed||signal.aborted)return {bars:[],hasMore:false,nextBefore:null};
    const args=new URLSearchParams({exchange:listing.exchange,market:listing.market,
      symbol:listing.symbol,interval:req.interval,limit:String(limit)});
    if(before!==undefined)args.set('before',String(safeBefore(before,req.interval)));
    const response=await fetch('/qsyn/api/v1/crypto/bars?'+args,{
      credentials:'same-origin',cache:'no-store',signal,headers:{Accept:'application/json'},
    });
    if(!response.ok)throw Error('Public exchange history unavailable (HTTP '+response.status+')');
    const data=await response.json();
    if(data.schema!=='QSYN-PUBLIC-CRYPTO-BARS/1'||data.source!=='exchange_public'||
      data.exchange!==listing.exchange||data.market!==listing.market||
      data.symbol!==listing.symbol||data.interval!==req.interval||
      data.trading_enabled!==false||!data.pagination||
      typeof data.pagination.has_more!=='boolean'||
      data.pagination.before!==(before??null))throw Error('Invalid market history provenance');
    const bars=validBars(data.bars,req,limit);
    if(before!==undefined && bars.some(b=>b.time>=before))
      throw Error('Historical cursor failed to advance');
    const next=bars[0]?.time??null;
    if(data.pagination.next_before!==next)
      throw Error('Invalid historical next cursor');
    return {bars,nextBefore:next,hasMore:data.pagination.has_more};
  }
  // Re-query only a bounded number of confirmed internal gaps through the
  // SAME exchange-authoritative Rust/PHP history API. Never fill by time
  // interpolation and never schedule unrestricted provider requests.
  async _repairHistoryGaps(bars,req,listing,signal,maxRequests=2){
    if(signal.aborted||this.closed||bars.length<2)return bars;
    const step=SECONDS[req.interval];
    let result=bars;
    for(const gap of findProviderGaps(bars,step,{limit:maxRequests})){
      if(signal.aborted||this.closed)break;
      // A single paged probe must be able to span both ends of this gap.
      // Huge provider outages should not trigger a page storm.
      if(gap.missing>=PAGE_BARS)continue;
      const key=pageIdentity(req,listing)+':'+gap.left+':'+gap.right;
      if(!shouldAttemptGap(this.gapAttempts,key))continue;
      try{
        const page=await this._page(req,listing,signal,
          Math.min(PAGE_BARS,gap.missing+1),gap.right);
        if(signal.aborted||this.closed)break;
        result=mergeProviderGapBars(result,page.bars,step);
      }catch(error){
        if(signal.aborted||this.closed||error?.name==='AbortError')break;
        // Retain previously verified candles, but never trust a malformed
        // provider replay or claim an unavailable gap was repaired.
        this.onState('Exchange gap recovery unavailable · verified candles retained');
        break;
      }
    }
    return result;
  }
  async getBars(req) {
    if(this.closed)return [];
    const listing=findCrypto(req.exchange,req.symbol);
    if(!listing||!INTERVALS.has(req.interval))return [];
    const controller=new AbortController(),signal=req.signal;
    if(signal?.aborted)return [];
    this.controllers.add(controller);
    const cancel=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    try{
      const step=SECONDS[req.interval];
      const history=this.historyTargets.get(pageIdentity(req,listing))||0;
      const clock=Date.now()/1000;
      const desiredFrom=Number.isFinite(req.from)&&Number.isFinite(req.to)&&req.to>=req.from
        ? Math.ceil((req.to-req.from)/step):0;
      // A tail repair / explicit noCache pass never rereads 15k history bars.
      const desired=req.noCache ? PAGE_BARS :
        Math.min(MAX_AUTO_BACKFILL_BARS,Math.max(
          INITIAL_BACKFILL_BARS,history,Number.isFinite(req.countBack)?req.countBack:0,desiredFrom
        ));
      const to=Number.isFinite(req.to)&&req.to<clock-2*step
        ? Math.floor(req.to/step)*step+step : undefined;
      let before=to;
      const all=new Map();
      for(let pageIndex=0;pageIndex<PAGE_LIMIT && all.size<desired;pageIndex++){
        if(controller.signal.aborted)return [];
        const remain=desired-all.size, limit=Math.min(PAGE_BARS,Math.max(1,remain));
        const page=await this._page(req,listing,controller.signal,limit,before);
        if(!page.bars.length)break;
        for(const b of page.bars)all.set(b.time,b);
        if(!page.hasMore || all.size>=desired)break;
        if(page.nextBefore===null || (before!==undefined&&page.nextBefore>=before))
          throw Error('Market history cursor did not move backwards');
        before=page.nextBefore;
        if(!this.closed && pageIndex%4===3)
          this.onState(listing.exchange+' · automatically backfilled '+all.size+' / '+desired+' real candles');
      }
      const rows=[...all.values()].sort((a,b)=>a.time-b.time);
      const recovered=await this._repairHistoryGaps(rows,req,listing,controller.signal);
      if(controller.signal.aborted||this.closed)return [];
      // A replay must not expand the chart beyond its requested history
      // budget (in particular Wick Science's 15,016-candle ceiling).
      const repaired=recovered.length>desired?recovered.slice(-desired):recovered;
      const inserted=Math.max(0,recovered.length-rows.length);
      const missing=findProviderGaps(repaired,step,{limit:1}).length>0;
      if(!this.closed)this.onState(listing.exchange+' '+listing.market.toUpperCase()+
        ' · '+repaired.length+' verified real candles'+
        (inserted?' · '+inserted+' genuine candles recovered':
          missing?' · unresolved provider gaps':' · no internal gaps detected'));
      return repaired;
    }catch(error){
      if(controller.signal.aborted || signal?.aborted ||this.closed||error?.name==='AbortError')return [];
      this.onState('Exchange history unavailable · no simulated fallback');
      throw error;
    }finally{
      signal?.removeEventListener('abort',cancel);
      this.controllers.delete(controller);
    }
  }
  /**
   * OpenAlgo native older-history paging, initiated by scroll/go-to. Complements
   * initial automatic MFE backfill, retains provider limit and true gaps.
   */
  async getBarsPage(req){
    const listing=findCrypto(req.exchange,req.symbol);
    if(this.closed||!listing||!INTERVALS.has(req.interval))return {bars:[],hasMore:false};
    const before=req.before;
    if(!Number.isSafeInteger(before))return {bars:[],hasMore:false};
    const controller=new AbortController();
    if(req.signal?.aborted)return {bars:[],hasMore:false};
    this.controllers.add(controller);
    const cancel=()=>controller.abort();
    req.signal?.addEventListener('abort',cancel,{once:true});
    try{
      const count=Math.max(1,Math.min(PAGE_BARS,
        Number.isSafeInteger(req.countBack)?req.countBack:PAGE_BARS));
      const page=await this._page(req,listing,controller.signal,count,before);
      const repaired=await this._repairHistoryGaps(page.bars,req,listing,controller.signal,1);
      if(controller.signal.aborted||this.closed)return {bars:[],hasMore:false};
      const bars=repaired.length>count?repaired.slice(-count):repaired;
      return {bars,hasMore:page.hasMore,nextBefore:bars[0]?.time};
    }catch(error){
      if(controller.signal.aborted||req.signal?.aborted||this.closed||error?.name==='AbortError')
        return {bars:[],hasMore:false};
      throw error;
    }finally{
      req.signal?.removeEventListener('abort',cancel);
      this.controllers.delete(controller);
    }
  }
  subscribeBars(req,onBar,opts={}) {
    let live=true,pending=false,current=opts.seedFrom?.time||0,last=opts.seedFrom||null;
    const controller=new AbortController();
    this.controllers.add(controller);
    const tick=async()=>{
      if(!live||this.closed||pending)return;
      pending=true;
      try{
        const listing=findCrypto(req.exchange,req.symbol);
        if(!listing||!INTERVALS.has(req.interval))return;
        // Live polling never backfills the entire historical window.
        const page=await this._page(req,listing,controller.signal,2,undefined);
        if(!live||!page.bars.length)return;
        const newest=page.bars.at(-1);
        if(newest.time<current){opts.onResync?.();return;}
        if(current&&newest.time>current+SECONDS[req.interval]&&
          shouldAttemptGap(this.gapAttempts,pageIdentity(req,listing)+
            ':live:'+current+':'+newest.time))opts.onResync?.();
        if(!current||newest.time>current||JSON.stringify(newest)!==JSON.stringify(last)){
          onBar(newest,{provisional:false});current=newest.time;last=newest;
        }
      }catch{/* Foreground and health status remain independent of polling errors. */}
      finally{pending=false;}
    };
    const timer=setInterval(tick,4000);
    this.timers.add(timer);
    void tick();
    return ()=>{live=false;clearInterval(timer);this.timers.delete(timer);
      controller.abort();this.controllers.delete(controller);};
  }
  searchSymbols({query}){
    const q=String(query||'').toUpperCase().slice(0,48);
    return Promise.resolve(CRYPTO_MARKETS.filter(x=>!q||x.label.toUpperCase().includes(q)||x.id.includes(q))
      .slice(0,50).map(x=>({symbol:x.symbol,exchange:x.exchange+':'+x.market,
        name:x.label,assetClass:x.market==='spot'?'Crypto spot':'Crypto perpetual'})));
  }
  destroy(){
    this.closed=true;
    for(const controller of this.controllers)controller.abort();
    this.controllers.clear();
    for(const timer of this.timers)clearInterval(timer);
    this.timers.clear();
    this.historyTargets.clear();
    this.gapAttempts.clear();
  }
}

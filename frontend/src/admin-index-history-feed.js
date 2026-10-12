import {QsynMarketsFeed,validIndexBarTime} from './qsyn-markets-feed.js';
import {findIndiaIndex} from './india-index-catalog.js';

const API='/qsyn/api/v1/admin/upstox/index-candles';
const INTERVALS=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});

/**
 * Private administrator chart uses the existing Analytics Token held only by
 * PHP. No Rust process, WSS proxy, broker-order credential or fake OHLC.
 * Real candles are provider-generated V3 history/intraday snapshots. This
 * is NOT equivalent to an exchange-tick live WebSocket subscription.
 */
export class AdminIndexHistoryFeed extends QsynMarketsFeed {
  constructor(onState=()=>{},deps={}){
    super(onState,{onBlockedIndex:()=>{}});
    // Native window.fetch requires its browser receiver; calling it as
    // this.fetcher(url, options) can throw before any HTTP request.
    this.fetcher=deps.fetcher||((url,options)=>fetch(url,options));
    this.onBlockedIndex=deps.onBlockedIndex||(()=>{});
    this.lastRows=new Map();
    this.pollEveryMs=60000;
  }
  async getBars(req){
    const index=findIndiaIndex(req.exchange,req.symbol);
    if(!index)return super.getBars(req);
    if(this.closed||!Object.hasOwn(INTERVALS,req.interval)||req.signal?.aborted)return [];
    const controller=new AbortController();
    const onAbort=()=>controller.abort();
    req.signal?.addEventListener('abort',onAbort,{once:true});
    this.controllers.add(controller);
    try{
      const url=API+'?'+new URLSearchParams({
        symbol:index.symbol,interval:req.interval,
        limit:String(req.noCache?2:Math.min(500,Math.max(300,req.countBack||300))),
      });
      const resp=await this.fetcher(url,{credentials:'same-origin',cache:'no-store',
        signal:controller.signal,headers:{Accept:'application/json'}});
      if(!resp.ok){
        const data=await resp.json().catch(()=>null);
        const code=typeof data?.code==='string'&&/^[A-Z0-9_]{4,80}$/.test(data.code)
          ?data.code:'UPSTOX_INDEX_HTTP_'+resp.status;
        this.onState(index.name+' · '+code);
        if([401,403,409,424,503].includes(resp.status))
          this.onBlockedIndex({exchange:index.exchange,symbol:index.symbol,name:index.name});
        return [];
      }
      const payload=await resp.json();
      if(payload.schema!=='QSYN-UPSTOX-ADMIN-INDEX-CANDLES/1' ||
        payload.source!=='upstox_authenticated_personal_history' ||
        payload.exchange!==index.exchange||payload.symbol!==index.symbol||
        payload.interval!==req.interval ||
        payload.provider_authenticated!==true ||
        payload.trading_enabled!==false ||
        payload.public_redistribution_allowed!==false ||
        payload.live_socket_verified!==false ||
        !Array.isArray(payload.bars)||payload.bars.length>500)
        throw Error('Invalid provider index candle provenance');
      let prev=0;
      for(const bar of payload.bars){
        if(!validIndexBarTime(bar.time,req.interval)||bar.time<=prev||
          bar.time>Math.floor(Date.now()/1000)+60 ||
          !['open','high','low','close','volume'].every(k=>Number.isFinite(bar[k]))||
          bar.open<=0||bar.close<=0||bar.low<=0||
          bar.high<Math.max(bar.open,bar.close) ||
          bar.low>Math.min(bar.open,bar.close)||bar.volume<0)
          throw Error('Upstox returned invalid index OHLC');
        prev=bar.time;
      }
      if(!this.closed){
        this.onBlockedIndex(null);
        this.onState(index.name+' · '+payload.bars.length+
          ' real Upstox candles · read-only history/intraday · not WebSocket live');
      }
      return controller.signal.aborted||this.closed?[]:payload.bars;
    }catch(e){
      if(controller.signal.aborted||this.closed||e?.name==='AbortError')return [];
      this.onState(index.name+' · personal Upstox historical data unavailable');
      return [];
    }finally{
      req.signal?.removeEventListener('abort',onAbort);
      this.controllers.delete(controller);
    }
  }
  subscribeBars(req,onBar,options={}){
    const index=findIndiaIndex(req.exchange,req.symbol);
    if(!index)return super.subscribeBars(req,onBar,options);
    if(!Object.hasOwn(INTERVALS,req.interval))return ()=>{};
    let alive=true,pending=false;
    let last=options.seedFrom||null;
    const controller=new AbortController();
    this.controllers.add(controller);
    const poll=async()=>{
      if(!alive||pending||this.closed)return;
      pending=true;
      try{
        const rows=await this.getBars({...req,noCache:true,signal:controller.signal});
        const bar=rows.at(-1);
        if(!bar||!alive)return;
        if(last && bar.time<last.time)return;
        if(!last||bar.time>last.time || JSON.stringify(bar)!==JSON.stringify(last)){
          onBar(bar,{provisional:false});last=bar;
        }
      }finally{pending=false;}
    };
    const timer=setInterval(poll,this.pollEveryMs);
    this.timers.add(timer);
    void poll();
    return ()=>{alive=false;controller.abort();clearInterval(timer);
      this.timers.delete(timer);this.controllers.delete(controller);};
  }
}

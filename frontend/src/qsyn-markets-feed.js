import {QsynCryptoFeed} from './crypto-feed.js';
import {findIndiaIndex,searchIndiaIndexes} from './india-index-catalog.js';
import {PrivateIndexHistoryFeed,todayIst} from './personal-index-feed.js';
import {findProviderGaps,mergeProviderGapBars,shouldAttemptGap} from './market-gap-recovery.js';

const INTERVALS=new Set(['1s','1m','5m','15m','1h','1d']);
const STEPS=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});
const IST_OFFSET=19800;
const PROOF='/qsyn/api/v1/admin/upstox/index-history-proof';
function indexBucketStart(time,interval){
  const step=STEPS[interval];
  const istDay=Math.floor((time+IST_OFFSET)/86400)*86400-IST_OFFSET;
  const open=istDay+9*3600+15*60;
  return interval==='1d'?istDay:interval==='1h'
    ?open+Math.floor((time-open)/step)*step
    :Math.floor((time+IST_OFFSET)/step)*step-IST_OFFSET;
}


export function validIndexBarTime(time,interval){
  if(!Number.isSafeInteger(time)||time<=0)return false;
  if(interval==='1s')return true;
  if(time%60!==0)return false;
  if(interval==='1d')return (time+IST_OFFSET)%86400===0;
  if(interval==='5m'||interval==='15m')
    return (time+IST_OFFSET)%STEPS[interval]===0;
  return INTERVALS.has(interval);
}

/** Aggregate REAL Rust-returned 1m OHLC into native chart intervals.
 * Never synthesize missing periods or exchange prices. Session 1h buckets
 * start at the exchange open (09:15 IST); 1d candles use IST midnight.
 */
export function aggregatePersonalIndexBars(bars,interval){
  if(!INTERVALS.has(interval)||!Array.isArray(bars))throw Error('INVALID_INDEX_INTERVAL');
  if(interval==='1m'||interval==='1s')return bars;
  const groups=new Map(),step=STEPS[interval];
  for(const bar of bars){
    const istDay=Math.floor((bar.time+IST_OFFSET)/86400)*86400-IST_OFFSET;
    const open=istDay+9*3600+15*60;
    const time=interval==='1d'?istDay:interval==='1h'
      ?open+Math.floor((bar.time-open)/step)*step
      :Math.floor((bar.time+IST_OFFSET)/step)*step-IST_OFFSET;
    const previous=groups.get(time);
    if(!previous)groups.set(time,{time,open:bar.open,high:bar.high,
      low:bar.low,close:bar.close,volume:bar.volume});
    else{
      previous.high=Math.max(previous.high,bar.high);
      previous.low=Math.min(previous.low,bar.low);
      previous.close=bar.close;
      previous.volume+=bar.volume;
    }
  }
  return [...groups.values()].sort((a,b)=>a.time-b.time);
}

/** Public cryptocurrencies remain public. India index candles require an
 * existing QSYN administrator cookie plus the separately stored personal
 * Analytics Token. No NSE/BSE OHLC endpoint is exposed to anonymous users.
 * The same Rust history and WSS adapter powers the private Markets chart.
 */
export function latestPersonalIndexBar(bars,interval){
  if(!INTERVALS.has(interval)||!Array.isArray(bars))
    throw Error('INVALID_INDEX_INTERVAL');
  if(!bars.length)return null;
  const last=bars[bars.length-1];
  if(interval==='1m'||interval==='1s')return last;
  const time=indexBucketStart(last.time,interval);
  let first=bars.length-1;
  while(first>0&&indexBucketStart(bars[first-1].time,interval)===time)
    first--;
  let high=-Infinity,low=Infinity,volume=0;
  for(let i=first;i<bars.length;i++){
    const bar=bars[i];
    high=Math.max(high,bar.high);
    low=Math.min(low,bar.low);
    volume+=bar.volume;
  }
  return {time,open:bars[first].open,high,low,close:last.close,volume};
}

/** Public cryptocurrencies remain public. India index candles require an
 * existing QSYN administrator cookie plus the separately stored personal
 * Analytics Token. No NSE/BSE OHLC endpoint is exposed to anonymous users.
 * The same Rust history and WSS adapter powers the private Markets chart.
 */

export class QsynMarketsFeed extends QsynCryptoFeed {
  constructor(onState=()=>{}, {onBlockedIndex=()=>{},onUnsupportedCryptoSecond=()=>{},initialPriorSession=false}={}){
    super(onState);
    this.onBlockedIndex=onBlockedIndex;
    this.onUnsupportedCryptoSecond=onUnsupportedCryptoSecond;
    this.indexGapAttempts=new Map();
    this.indexGapPending=new Map();
    this.initialPriorSession=initialPriorSession;
    this.personalProof=null;
    this.personalFeeds=new Map();
    this.personalBars=new Map();
    this.historyStatus=new Map();
    this.indexHistoryDays=new Map();
    // A genuinely empty provider response is retryable; never retain it forever.
    this.indexHistoryMisses=new Map();
    this.activeIndex=null;
  }
  async _proof(){
    if(!this.personalProof){
      this.personalProof=(async()=>{
        // Owner-only access never consumes an administrator session.
        const owner=await fetch('/qsyn/api/v1/owner-index/status',{
          method:'GET',credentials:'same-origin',cache:'no-store',
          headers:{Accept:'application/json'}
        }).catch(()=>null);
        if(owner?.ok){
          const state=await owner.json();
          if(state.schema==='QSYN-PERSONAL-INDEX-OWNER-VIEWER/1'
            && ['owner-ip-allowlist','owner-browser-grant'].includes(state.access)
            && state.trading_enabled===false
            && state.public_redistribution_allowed===false
            && Array.isArray(state.symbols)
            && state.symbols.length===7
            && /^20\d{2}-\d{2}-\d{2}$/.test(state.suggested_day_ist)){
            return {ownerViewer:true,csrf:null,suggested_day_ist:state.suggested_day_ist};
          }
        }
        const response=await fetch(PROOF,{
          method:'GET',credentials:'same-origin',cache:'no-store',
          headers:{Accept:'application/json'},
        });
        if(!response.ok)throw Error(response.status===401
          ?'QSYN_ADMIN_LOGIN_REQUIRED':'UPSTOX_PERSONAL_TOKEN_UNAVAILABLE');
        const data=await response.json();
        if(data.schema!=='QSYN-INDEX-HISTORICAL-PROOF/1'
          ||data.token_present!==true
          ||typeof data.csrf!=='string'
          ||!/^[a-f0-9]{64}$/i.test(data.csrf)
          ||!/^20\d{2}-\d{2}-\d{2}$/.test(data.suggested_day_ist))
          throw Error('UPSTOX_PERSONAL_TOKEN_UNAVAILABLE');
        return data;
      })().catch(e=>{
        this.personalProof=null;
        throw e;
      });
    }
    return this.personalProof;
  }
  _session(instrument,day,csrf,ownerViewer=false){
    const key=instrument.id;
    const old=this.personalFeeds.get(key);
    if(old?.day===day&&old?.ownerViewer===ownerViewer)return old;
    old?.destroy();
    this.personalBars.delete(key);
    this.historyStatus.delete(key);
    const feed=new PrivateIndexHistoryFeed({
      symbol:instrument.symbol,day,csrf,ownerViewer,
      onStatus:msg=>{if(!this.closed)this.onState(instrument.name+' · '+msg);},
      onLive:msg=>{
        if(!this.closed)this.onState((this.historyStatus.get(key)||
          instrument.name+' · awaiting private Rust history')+' · '+msg);
      }
    });
    this.personalFeeds.set(key,feed);
    return feed;
  }
  async getBars(req){
    const instrument=findIndiaIndex(req.exchange,req.symbol);
    if(!instrument){
      if(this.activeIndex!==null){
        this.activeIndex=null;
        this.onBlockedIndex(null);
      }
      if(req.interval==='1s'){
        this.onUnsupportedCryptoSecond(req);
        this.onState('Crypto 1-second candles unavailable; choose 1m or higher');
        return [];
      }
      return super.getBars(req);
    }
    if(this.closed||!INTERVALS.has(req.interval))return [];
    try{
      const proof=await this._proof();
      if(this.closed||req.signal?.aborted)return [];
      this.activeIndex=instrument.id;
      this.onBlockedIndex(null);
      if(req.interval==='1s'){
        this._session(instrument,todayIst(),proof.csrf,proof.ownerViewer===true);
        this.onState(instrument.name+' · live 1-second bars only; no historical 1s available');
        return [];
      }
      const istNow=todayIst();
      const dayOfWeek=new Date(istNow+'T12:00:00+05:30').getUTCDay();
      const weekday=dayOfWeek>=1&&dayOfWeek<=5;
      const minutes=Number(new Intl.DateTimeFormat('en-GB',{
        timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
      }).format(new Date()).replace(':',''));
      const todayIsAvailable=weekday&&minutes>=915;
      const requestedDay=todayIsAvailable?istNow:proof.suggested_day_ist;
      // Live subscriptions remain scoped to the selected/current trading
      // day even when its Upstox intraday history is legitimately empty.
      // Previous-day history must never replace today's live WSS session.
      const feed=this._session(instrument,requestedDay,proof.csrf,proof.ownerViewer===true);
      const scoped={...req,exchange:'UPSTOX_PERSONAL',
        symbol:instrument.symbol,interval:'1m',strictHistory:true};
      let bars=await feed.getBars(scoped);
      let day=requestedDay;
      if(!bars.length){
        const start=Math.floor(Date.parse(requestedDay+'T00:00:00+05:30')/1000);
        for(let d=1;d<=7 && !bars.length;d++){
          if(this.closed||req.signal?.aborted)return [];
          const local=new Date((start-d*86400+IST_OFFSET)*1000);
          if(local.getUTCDay()===0||local.getUTCDay()===6)continue;
          const olderDay=local.toISOString().slice(0,10);
          if(olderDay<'2022-01-01')break;
          const previous=await this._historicalDay(instrument,olderDay,proof.csrf,req.signal,proof.ownerViewer===true);
          if(previous.length){
            bars=previous;
            day=olderDay;
          }
        }
      }
      if(this.closed||req.signal?.aborted)return [];
      let previousCoverage='';
      if(bars.length){
        // Cache the CURRENT date independently from any older candles, so
        // a later daily-page lookup cannot corrupt this day's OHLC.
        const cached=this.indexHistoryDays.get(instrument.id+':'+day)||[];
        bars=mergeProviderGapBars(bars,cached,60,{index:true});
        bars=await this._repairIndexDay(instrument,day,bars,proof,req.signal);
        this._cacheIndexDay(instrument,day,bars);
        // OpenAlgo can initially request 1600 bars but the Upstox reader
        // serves only ONE trading day. Explicitly load the preceding weekday
        // when the requested window reaches beyond today's first candle.
        // Other days remain lazily paginated; tail refreshes stay cheap.
        // A native OpenAlgo refresh replaces every candle inside its
        // requested window. If that window touches the preceding session,
        // return those real historical bars AGAIN, including for noCache.
        // Otherwise the controller interprets the omitted session as a
        // deletion and yesterday appears to vanish during polling/repair.
        // _historicalDay uses the authenticated bounded per-date cache, so
        // normal tail refreshes do not repeatedly call Upstox for old bars.
        // The widget may omit both from and countBack on first render.
        // Still request one prior real session; otherwise a full-day response
        // (375 bars) permanently hides yesterday until a manual pan/zoom.
        // Also preserve a previously displayed prior day on tail/repair calls.
        const existing=this.personalBars.get(instrument.id);
        const needsPrior=(this.initialPriorSession&&!existing) ||
          (existing?.some(bar=>bar.time<bars[0].time)??false) ||
          (Number.isFinite(req.from)&&req.from<bars[0].time) ||
          (req.noCache!==true&&Number.isSafeInteger(req.countBack)&&
            req.countBack>bars.length);
        if(needsPrior){
          const anchor=Math.floor(Date.parse(day+'T00:00:00+05:30')/1000);
          for(let offset=1;offset<=4;offset++){
            const previous=new Date((anchor-offset*86400+IST_OFFSET)*1000);
            if([0,6].includes(previous.getUTCDay()))continue;
            const olderDay=previous.toISOString().slice(0,10);
            if(olderDay<'2022-01-01')break;
            try{
              const older=await this._historicalDay(
                instrument,olderDay,proof.csrf,req.signal,proof.ownerViewer===true);
              if(this.closed||req.signal?.aborted)return [];
              if(older.length){
                bars=[...older.filter(bar=>bar.time<bars[0].time),...bars];
              }else{
                // If a refresh already showed real older bars in this
                // interval, an empty provider answer must NOT delete them.
                const previousShown=this.personalBars.get(instrument.id)||[];
                const knownPrior=previousShown.some(bar=>bar.time<bars[0].time &&
                  (!Number.isFinite(req.from)||bar.time>=req.from));
                if(req.noCache===true&&knownPrior)
                  throw Error('INDEX_PRIOR_SESSION_REPAIR_INCOMPLETE');
                // No fabricated candles for provider outages or holidays.
                previousCoverage=' · prior '+olderDay+' history unavailable';
              }
            }catch(error){
              if(this.closed||req.signal?.aborted||error?.name==='AbortError')return [];
              // A refresh failure must retain the existing chart window
              // instead of passing partial new bars to OpenAlgo.
              if(req.noCache===true)throw error;
              previousCoverage=' · prior '+olderDay+' history request failed';
            }
            break; // At most one additional history request per initial load.
          }
        }
        this.personalBars.set(instrument.id,bars);
      }
      const result=aggregatePersonalIndexBars(bars,req.interval);
      if(bars.length){
        const label=instrument.name+' · '+bars.length+
          ' real Rust Upstox 1m candles'+
          (req.interval==='1m'?'':' · derived '+req.interval)+
          previousCoverage;
        this.historyStatus.set(instrument.id,label);
        this.onState(label);
      }
      return result;
    }catch(error){
      if(this.closed||req.signal?.aborted||error?.name==='AbortError')return [];
      this.onState(error?.message==='QSYN_ADMIN_LOGIN_REQUIRED'
        ?'Index source unavailable for this viewer'
        :error?.message==='UPSTOX_PERSONAL_TOKEN_UNAVAILABLE'
          ?'Private index · store or verify your Upstox Analytics Token'
          :'Private index · Rust 1-minute Upstox history unavailable; retry after checking your account');
      if(this.activeIndex!==instrument.id){
        this.activeIndex=instrument.id;
        this.onBlockedIndex({exchange:instrument.exchange,
          symbol:instrument.symbol,name:instrument.name});
      }
      return [];
    }
  }
  // Unlike the live feed, history reads have no browser WebSocket side
  // effects. LRU bounds memory and prevents repeated daily Upstox requests
  // as the user scrolls left/right through the same session.
  _cacheIndexDay(instrument,day,bars){
    const key=instrument.id+':'+day;
    this.indexHistoryDays.delete(key);
    this.indexHistoryDays.set(key,bars);
    while(this.indexHistoryDays.size>64)
      this.indexHistoryDays.delete(this.indexHistoryDays.keys().next().value);
  }
  async _historicalDay(instrument,day,csrf,signal,ownerViewer=false,refresh=false){
    const key=instrument.id+':'+day;
    if(!refresh&&this.indexHistoryDays.has(key))return this.indexHistoryDays.get(key);
    if((this.indexHistoryMisses.get(key)||0)>Date.now())return [];
    this.indexHistoryMisses.delete(key);
    const temp=new PrivateIndexHistoryFeed({symbol:instrument.symbol,day,csrf,ownerViewer,
      onStatus:()=>{},onLive:()=>{}});
    try{
      const bars=await temp.getBars({symbol:instrument.symbol,
        exchange:'UPSTOX_PERSONAL',interval:'1m',signal,strictHistory:true});
      if(this.closed||signal?.aborted)return [];
      if(bars.length){
        this.indexHistoryMisses.delete(key);
        this._cacheIndexDay(instrument,day,bars);
      }else{
        // Short negative TTL prevents repeated requests during scroll while
        // allowing recovery after a transient empty Rust/provider response.
        this.indexHistoryMisses.set(key,Date.now()+30_000);
        while(this.indexHistoryMisses.size>64)
          this.indexHistoryMisses.delete(this.indexHistoryMisses.keys().next().value);
      }
      return bars;
    }finally{
      temp.destroy();
    }
  }
  async _repairIndexDay(instrument,day,bars,proof,signal){
    const gaps=findProviderGaps(bars,60,{index:true,limit:1});
    if(!gaps.length)return bars;
    const key=instrument.id+':'+day;
    if(!shouldAttemptGap(this.indexGapAttempts,key))return bars;
    try{
      const fresh=await this._historicalDay(instrument,day,proof.csrf,signal,proof.ownerViewer===true,true);
      const merged=mergeProviderGapBars(bars,fresh,60,{index:true});
      this._cacheIndexDay(instrument,day,merged);
      return merged;
    }catch(error){
      if(!signal?.aborted)this.onState(instrument.name+' · provider gap recovery unavailable');
      return bars;
    }
  }
  /** Native OpenAlgo left-scroll cursor. One private Rust 1m trading-day
   * request per date, never a PHP price poll or public API. Historical dates
   * are requested only on demand; no fabricated holiday candles.
   */
  async getBarsPage(req){
    const instrument=findIndiaIndex(req.exchange,req.symbol);
    if(!instrument)return super.getBarsPage(req);
    if(this.closed||req.signal?.aborted||!INTERVALS.has(req.interval)||
      req.interval==='1s'||!Number.isSafeInteger(req.before))
      return {bars:[],hasMore:false};
    const minTime=Math.floor(Date.parse('2022-01-01T00:00:00+05:30')/1000);
    if(req.before<=minTime||req.before>Date.now()/1000+86400)
      return {bars:[],hasMore:false};
    const count=Math.max(1,Math.min(300,
      Number.isSafeInteger(req.countBack)?req.countBack:300));
    // Bounded pagination: at most 10 calendar dates, no unbounded Upstox
    // calls in one scroll gesture. Higher intervals assemble from true 1m
    // candles, so fewer than count bars per page is expected.
    const rawTarget=req.interval==='1m'?count:Math.min(1500,
      count*(req.interval==='5m'?5:req.interval==='15m'?15:
        req.interval==='1h'?60:375));
    const candidateStart=req.before-1;
    const collected=new Map();
    let searched=0,oldestSearched=null;
    try{
      const proof=await this._proof();
      for(let d=0;d<10 && collected.size<rawTarget;d++){
        if(this.closed||req.signal?.aborted)return {bars:[],hasMore:false};
        const cursor=candidateStart-d*86400;
        if(cursor<minTime)break;
        const date=new Date(cursor*1000+IST_OFFSET*1000);
        const weekday=date.getUTCDay();
        if(weekday===0||weekday===6)continue;
        const day=date.toISOString().slice(0,10);
        if(day<'2022-01-01')break;
        oldestSearched=day;
        const bars=await this._historicalDay(instrument,day,proof.csrf,req.signal,proof.ownerViewer===true);
        searched++;
        for(const bar of bars){
          if(bar.time<req.before)collected.set(bar.time,bar);
        }
      }
      if(this.closed||req.signal?.aborted)return {bars:[],hasMore:false};
      const raw=[...collected.values()].sort((a,b)=>a.time-b.time);
      let bars=aggregatePersonalIndexBars(raw,req.interval)
        .filter(b=>b.time<req.before);
      if(bars.length>count)bars=bars.slice(-count);
      const nextBefore=bars[0]?.time;
      if(bars.length)this.onState(instrument.name+' · '+bars.length+
        ' older Upstox '+req.interval+' candles · verified Rust 1m history');
      // Empty trading days/holidays are not history exhaustion; a later
      // gesture can extend the search when provider data is available.
      return {bars,hasMore:!!bars.length&&
        (oldestSearched===null||oldestSearched>'2022-01-01'),
        ...(nextBefore===undefined?{}:{nextBefore})};
    }catch(error){
      if(this.closed||req.signal?.aborted||error?.name==='AbortError')
        return {bars:[],hasMore:false};
      this.onState(instrument.name+' · older Rust history unavailable; retry later');
      throw error;
    }
  }
  subscribeBars(req,onBar,opts={}){
    const instrument=findIndiaIndex(req.exchange,req.symbol);
    if(!instrument)return super.subscribeBars(req,onBar,opts);
    const session=this.personalFeeds.get(instrument.id);
    if(!session||this.closed)return ()=>{};
    const scoped={...req,exchange:'UPSTOX_PERSONAL',symbol:instrument.symbol,
      interval:req.interval==='1s'?'1s':'1m'};
    let active=true;
    const stop=session.subscribeBars(scoped,minuteBar=>{
      if(req.interval==='1s'){
        onBar(minuteBar,{provisional:true});
        return;
      }
      const prior=this.personalBars.get(instrument.id)||[];
      const previous=prior.at(-1);
      const liveGap=previous&&findProviderGaps([previous,minuteBar],60,
        {index:true,limit:1}).length>0;
      if(prior.length&&prior.at(-1).time===minuteBar.time)
        prior[prior.length-1]=minuteBar;
      else if(!prior.length||prior.at(-1).time<minuteBar.time)
        prior.push(minuteBar);
      if(prior.length>400)prior.shift();
      this.personalBars.set(instrument.id,prior);
      const latest=latestPersonalIndexBar(prior,req.interval);
      if(latest)onBar(latest,{provisional:true});
      if(liveGap&&typeof opts.onResync==='function'&&active){
        const key=instrument.id+':'+session.day;
        if(!this.indexGapPending.has(key)){
          const pending=(async()=>{
            const proof=await this._proof();
            if(!active||this.closed||req.signal?.aborted)return;
            const before=this.personalBars.get(instrument.id)||[];
            const fixed=await this._repairIndexDay(instrument,session.day,
              before,proof,req.signal);
            if(!active||this.closed||req.signal?.aborted||
              fixed.length<=before.length)return;
            // Live ticks may have arrived while the day replay was in flight.
            // Merge into that NEWER live window and ask the chart to reload
            // its verified history, rather than publishing out-of-order bars.
            const current=this.personalBars.get(instrument.id)||[];
            this.personalBars.set(instrument.id,
              mergeProviderGapBars(current,fixed,60,{index:true}));
            opts.onResync?.();
          })().catch(()=>{}).finally(()=>{this.indexGapPending.delete(key);});
          this.indexGapPending.set(key,pending);
        }
      }
    });
    return ()=>{active=false;stop();};
  }
  async searchSymbols({query}){
    const publicSymbols=await super.searchSymbols({query});
    return [...searchIndiaIndexes(query),...publicSymbols].slice(0,50);
  }
  destroy(){
    for(const session of this.personalFeeds.values())session.destroy();
    this.indexGapAttempts.clear();
    this.indexGapPending.clear();
    this.personalFeeds.clear();
    this.personalBars.clear();
    this.historyStatus.clear();
    this.indexHistoryDays.clear();
    this.indexHistoryMisses.clear();
    this.personalProof=null;
    super.destroy();
  }
}

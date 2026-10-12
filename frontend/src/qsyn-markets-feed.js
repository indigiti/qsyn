import {QsynCryptoFeed} from './crypto-feed.js';
import {findIndiaIndex,searchIndiaIndexes} from './india-index-catalog.js';
import {PrivateIndexHistoryFeed,todayIst} from './personal-index-feed.js';

const INTERVALS=new Set(['1m','5m','15m','1h','1d']);
const STEPS=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});
const IST_OFFSET=19800;
const PROOF='/qsyn/api/v1/admin/upstox/index-history-proof';

export function validIndexBarTime(time,interval){
  if(!Number.isSafeInteger(time)||time<=0||time%60!==0)return false;
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
  if(interval==='1m')return bars;
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
export class QsynMarketsFeed extends QsynCryptoFeed {
  constructor(onState=()=>{}, {onBlockedIndex=()=>{}}={}){
    super(onState);
    this.onBlockedIndex=onBlockedIndex;
    this.personalProof=null;
    this.personalFeeds=new Map();
    this.personalBars=new Map();
    this.activeIndex=null;
  }
  async _proof(){
    if(!this.personalProof){
      this.personalProof=(async()=>{
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
  _session(instrument,day,csrf){
    const key=instrument.id;
    const old=this.personalFeeds.get(key);
    if(old?.day===day)return old;
    old?.destroy();
    this.personalBars.delete(key);
    const feed=new PrivateIndexHistoryFeed({
      symbol:instrument.symbol,day,csrf,
      onStatus:msg=>{if(!this.closed)this.onState(instrument.name+' · '+msg);},
      onLive:msg=>{if(!this.closed)this.onState(instrument.name+' · '+msg);}
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
      return super.getBars(req);
    }
    if(this.closed||!INTERVALS.has(req.interval))return [];
    try{
      const proof=await this._proof();
      if(this.closed||req.signal?.aborted)return [];
      this.activeIndex=instrument.id;
      this.onBlockedIndex(null);
      const istNow=todayIst();
      const dayOfWeek=new Date(istNow+'T12:00:00+05:30').getUTCDay();
      const weekday=dayOfWeek>=1&&dayOfWeek<=5;
      const minutes=Number(new Intl.DateTimeFormat('en-GB',{
        timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
      }).format(new Date()).replace(':',''));
      const todayIsAvailable=weekday&&minutes>=915;
      let day=todayIsAvailable?istNow:proof.suggested_day_ist;
      let feed=this._session(instrument,day,proof.csrf);
      const scoped={...req,exchange:'UPSTOX_PERSONAL',symbol:instrument.symbol,interval:'1m'};
      let bars=await feed.getBars(scoped);
      if(bars.length===0&&day!==proof.suggested_day_ist){
        day=proof.suggested_day_ist;
        feed=this._session(instrument,day,proof.csrf);
        bars=await feed.getBars(scoped);
      }
      if(this.closed||req.signal?.aborted)return [];
      if(bars.length)this.personalBars.set(instrument.id,bars);
      const result=aggregatePersonalIndexBars(bars,req.interval);
      if(bars.length)this.onState(instrument.name+' · '+bars.length+
        ' real Rust Upstox 1m candles · '+day+
        (req.interval==='1m'?'':' · derived '+req.interval));
      return result;
    }catch(error){
      if(this.closed||req.signal?.aborted||error?.name==='AbortError')return [];
      this.onState(error?.message==='QSYN_ADMIN_LOGIN_REQUIRED'
        ?'Private index · sign in to QSYN Terminal'
        :'Private index · store or verify your Upstox Analytics Token');
      if(this.activeIndex!==instrument.id){
        this.activeIndex=instrument.id;
        this.onBlockedIndex({exchange:instrument.exchange,
          symbol:instrument.symbol,name:instrument.name});
      }
      return [];
    }
  }
  // One completed day is already returned in full by Rust; do not pass
  // personal index cursors to the public crypto pagination path.
  async getBarsPage(req){
    if(findIndiaIndex(req.exchange,req.symbol))
      return {bars:[],hasMore:false};
    return super.getBarsPage(req);
  }
  subscribeBars(req,onBar,opts={}){
    const instrument=findIndiaIndex(req.exchange,req.symbol);
    if(!instrument)return super.subscribeBars(req,onBar,opts);
    const session=this.personalFeeds.get(instrument.id);
    if(!session||this.closed)return ()=>{};
    const scoped={...req,exchange:'UPSTOX_PERSONAL',symbol:instrument.symbol,interval:'1m'};
    return session.subscribeBars(scoped,minuteBar=>{
      const prior=this.personalBars.get(instrument.id)||[];
      if(prior.length&&prior.at(-1).time===minuteBar.time)
        prior[prior.length-1]=minuteBar;
      else if(!prior.length||prior.at(-1).time<minuteBar.time)
        prior.push(minuteBar);
      if(prior.length>400)prior.shift();
      this.personalBars.set(instrument.id,prior);
      const bars=aggregatePersonalIndexBars(prior,req.interval);
      if(bars.length)onBar(bars.at(-1),{provisional:true});
    });
  }
  async searchSymbols({query}){
    const publicSymbols=await super.searchSymbols({query});
    return [...searchIndiaIndexes(query),...publicSymbols].slice(0,50);
  }
  destroy(){
    for(const session of this.personalFeeds.values())session.destroy();
    this.personalFeeds.clear();
    this.personalBars.clear();
    this.personalProof=null;
    super.destroy();
  }
}

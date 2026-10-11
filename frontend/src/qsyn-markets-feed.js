import {QsynCryptoFeed} from './crypto-feed.js';
import {findIndiaIndex,searchIndiaIndexes} from './india-index-catalog.js';

const INTERVALS=new Set(['1m','5m','15m','1h','1d']);
const STEP=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});

/** Public crypto + entitlement-scoped India index symbol search.
 * The new index adapter is deliberately fail-closed until a licensed
 * Upstox account and index display entitlement are actually provisioned.
 * No quote-to-OHLC approximation and no fallback to fictional candles.
 */
export class QsynMarketsFeed extends QsynCryptoFeed {
  constructor(onState=()=>{}) {
    super(onState);
    this.unavailableIndexSymbols=new Set();
  }
  async getBars(req) {
    const instrument=findIndiaIndex(req.exchange,req.symbol);
    if(!instrument)return super.getBars(req);
    if(this.closed||!INTERVALS.has(req.interval))return [];
    const key=instrument.id+':'+req.interval;
    if(this.unavailableIndexSymbols.has(key))return [];
    const ac=new AbortController();
    this.controllers.add(ac);
    if(req.signal?.aborted){this.controllers.delete(ac);return [];}
    const onAbort=()=>ac.abort();
    req.signal?.addEventListener('abort',onAbort,{once:true});
    try{
      const params=new URLSearchParams({exchange:instrument.exchange,
        symbol:instrument.symbol,interval:req.interval,limit:'300'});
      const response=await fetch('/qsyn/api/v1/india/bars?'+params,{
        credentials:'same-origin',cache:'no-store',signal:ac.signal,
        headers:{Accept:'application/json'},
      });
      if([401,403,503].includes(response.status)){
        this.unavailableIndexSymbols.add(key);
        if(!this.closed)this.onState('India index · licensed Upstox chart authorization required');
        return [];
      }
      if(!response.ok)throw new Error('India index market data unavailable');
      const data=await response.json();
      if(data.schema!=='QSYN-LICENSED-INDIA-INDEX-BARS/1' ||
          data.source!=='licensed_broker_index' ||
          data.exchange!==instrument.exchange||data.symbol!==instrument.symbol||
          data.interval!==req.interval||data.account_scoped!==true||
          data.public_redistribution_allowed!==false||data.trading_enabled!==false||
          !Array.isArray(data.bars)||data.bars.length>300)
        throw new Error('Index chart source/entitlement validation failed');
      let prev=0;
      for(const b of data.bars){
        if(!Number.isSafeInteger(b.time)||b.time<=prev||b.time%STEP[req.interval]!==0||
            b.time>Math.floor(Date.now()/1000)+STEP[req.interval] ||
            !['open','high','low','close','volume'].every(k=>Number.isFinite(b[k]))||
            b.open<=0||b.close<=0||b.low<=0||b.high<Math.max(b.open,b.close)||
            b.low>Math.min(b.open,b.close)||b.volume<0)
          throw new Error('Invalid authenticated India index candle');
        prev=b.time;
      }
      if(!this.closed)this.onState(instrument.name+' · Upstox authorized chart · read-only');
      return data.bars;
    }catch(err){
      if(!ac.signal.aborted&&!this.closed){
        this.onState('India index unavailable · no simulated prices');
      }
      throw err;
    }finally{
      req.signal?.removeEventListener('abort',onAbort);
      this.controllers.delete(ac);
    }
  }
  async searchSymbols({query}) {
    const base=await super.searchSymbols({query});
    return [...searchIndiaIndexes(query),...base].slice(0,50);
  }
}

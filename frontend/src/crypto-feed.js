import {CRYPTO_MARKETS,findCrypto} from './crypto-catalog.js';

/** OpenAlgo DataFeed backed by QSYN Rust via a same-origin PHP boundary.
 * Live forming OHLCV refreshes through bounded REST polling (4 seconds).
 * There is no claim of exchange WebSocket streaming in this first release.
 */
export class QsynCryptoFeed {
  constructor(onState=()=>{}) {this.onState=onState;this.closed=false;this.controllers=new Set();this.timers=new Set();}
  async getBars(req) {
    if(this.closed) return [];
    const listing=findCrypto(req.exchange,req.symbol);
    if(!listing || !['1m','5m','15m','1h','1d'].includes(req.interval)) return [];
    const ac=new AbortController();
    this.controllers.add(ac);
    const signal=req.signal;
    if(signal?.aborted) {ac.abort();this.controllers.delete(ac);return [];}
    const onAbort=()=>ac.abort();
    signal?.addEventListener('abort',onAbort,{once:true});
    try {
      const args=new URLSearchParams({exchange:listing.exchange,market:listing.market,
        symbol:listing.symbol,interval:req.interval,limit:'300'});
      const res=await fetch('/qsyn/api/v1/crypto/bars?'+args,{credentials:'same-origin',cache:'no-store',signal:ac.signal});
      if(!res.ok) throw new Error('Public exchange feed unavailable');
      const data=await res.json();
      if(data.schema!=='QSYN-PUBLIC-CRYPTO-BARS/1' || data.source!=='exchange_public' ||
        data.exchange!==listing.exchange || data.market!==listing.market ||
        data.symbol!==listing.symbol || data.interval!==req.interval ||
        data.trading_enabled!==false || !Array.isArray(data.bars)) throw new Error('Market data validation failed');
      const bars=data.bars;
      if(!bars.length || bars.some((b,i)=>!Number.isSafeInteger(b.time)||b.time<=0 ||
        (i>0 && b.time<=bars[i-1].time) ||
        !['open','high','low','close','volume'].every(k=>Number.isFinite(b[k])) ||
        b.open<=0||b.close<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.volume<0)) {
        throw new Error('Invalid exchange candles');
      }
      if(!this.closed) this.onState(listing.exchange+' '+listing.market.toUpperCase()+' · public OHLCV · REST refreshed');
      return bars;
    } catch(error) {
      if(!ac.signal.aborted && !this.closed) this.onState('Exchange unavailable · no simulated fallback');
      throw error;
    } finally {signal?.removeEventListener('abort',onAbort);this.controllers.delete(ac);}
  }
  subscribeBars(req,onBar,opts={}) {
    let live=true, pending=false, current=opts.seedFrom?.time||0, last=opts.seedFrom||null;
    const ac=new AbortController();
    this.controllers.add(ac);
    const tick=async()=>{
      if(!live||this.closed||pending)return;
      pending=true;
      try {
        const bars=await this.getBars({...req,signal:ac.signal});
        if(!live || !bars.length)return;
        const newest=bars.at(-1);
        if(newest.time<current) {opts.onResync?.();return;}
        if(current && newest.time>current+intervalSeconds(req.interval)) opts.onResync?.();
        if(!current || newest.time>current || JSON.stringify(newest)!==JSON.stringify(last)) {
          onBar(newest,{provisional:false});
          current=newest.time;last=newest;
        }
      }catch {/* getBars already reports unavailability */}
      finally{pending=false;}
    };
    const timer=setInterval(tick,4000);
    this.timers.add(timer);
    tick();
    return ()=>{live=false;clearInterval(timer);this.timers.delete(timer);ac.abort();this.controllers.delete(ac);};
  }
  searchSymbols({query}) {
    const q=String(query||'').toUpperCase().slice(0,48);
    return Promise.resolve(CRYPTO_MARKETS.filter(x=>!q||x.label.toUpperCase().includes(q)||x.id.includes(q))
      .slice(0,50).map(x=>({symbol:x.symbol,exchange:x.exchange+':'+x.market,name:x.label,assetClass:x.market==='spot'?'Crypto spot':'Crypto perpetual'})));
  }
  destroy(){this.closed=true;for(const c of this.controllers)c.abort();this.controllers.clear();for(const t of this.timers)clearInterval(t);this.timers.clear();}
}
const intervalSeconds=i=>({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400}[i]||60);

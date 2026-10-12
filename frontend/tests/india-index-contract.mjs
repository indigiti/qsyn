import assert from 'node:assert/strict';
import { INDIA_INDEX_MARKETS,findIndiaIndex,searchIndiaIndexes } from '../src/india-index-catalog.js';
import { QsynMarketsFeed,validIndexBarTime } from '../src/qsyn-markets-feed.js';
import {indexIntentFor,saveIndexIntent,consumeIndexIntent,privateIndexTarget} from '../src/private-index-intent.js';

const epoch=value=>Math.floor(Date.parse(value)/1000);
assert(validIndexBarTime(epoch('2026-10-09T09:15:00+05:30'),'1h'),'NSE 09:15 hourly bucket');
assert(validIndexBarTime(epoch('2026-10-09T00:00:00+05:30'),'1d'),'IST midnight daily bucket');
assert(!validIndexBarTime(epoch('2026-10-09T00:00:00Z'),'1d'),'UTC daily cannot replace IST daily');
assert(validIndexBarTime(epoch('2026-10-09T09:15:00+05:30'),'15m'),'IST intraday 15m alignment');
assert(!validIndexBarTime(epoch('2026-10-09T09:16:00+05:30'),'15m'),'reject misaligned minute');
assert.equal(INDIA_INDEX_MARKETS.length,7);
assert.equal(new Set(INDIA_INDEX_MARKETS.map(x=>x.id)).size,7);
assert.equal(findIndiaIndex('NSE_INDEX:index','NIFTY')?.name,'NIFTY 50');
assert.equal(findIndiaIndex('BSE_INDEX:index','SENSEX')?.name,'SENSEX');
assert.equal(findIndiaIndex('BSE_INDEX:index','BANKEX')?.name,'S&P BSE BANKEX');
assert.equal(searchIndiaIndexes('bankex')[0].symbol,'BANKEX');
assert.equal(findIndiaIndex('NSE_INDEX:index','SENSEX'),null);
assert.equal(searchIndiaIndexes('nifty').length,4);
assert.equal(searchIndiaIndexes('sEnSeX')[0].symbol,'SENSEX');
assert.equal(searchIndiaIndexes('doesnotexist').length,0);
const status=[];
const feed=new QsynMarketsFeed(s=>status.push(s));
const all=await feed.searchSymbols({query:''});
assert(all.some(x=>x.exchange==='BINANCE:spot' && x.symbol==='BTCUSDT'));
assert(all.some(x=>x.exchange==='NSE_INDEX:index' && x.symbol==='NIFTY'));
assert(all.some(x=>x.exchange==='BSE_INDEX:index' && x.symbol==='SENSEX'));
assert(all.some(x=>x.exchange==='BSE_INDEX:index' && x.symbol==='BANKEX'));
assert.equal((await feed.searchSymbols({query:'bank nifty'}))[0].symbol,'BANKNIFTY');

// A public index alias may cross an admin-login redirect. Private account,
// signing ticket, provider key and quotes must NEVER be written to storage.
const data=new Map(),storage={
  setItem(k,v){data.set(k,v);},getItem(k){return data.get(k)||null;},
  removeItem(k){data.delete(k);}
};
const handoff=indexIntentFor('NSE_INDEX','NIFTY');
assert.equal(handoff.id,'NSE_INDEX:index:NIFTY');
assert.equal(privateIndexTarget(handoff),'/qsyn/terminal/markets');
assert(saveIndexIntent(handoff,storage));
assert.equal(consumeIndexIntent(storage).id,handoff.id);
assert.equal(consumeIndexIntent(storage),null,'one-use handoff must be cleared');
assert.equal(saveIndexIntent({exchange:'NSE_INDEX',symbol:'../../foreign'},storage),false);
assert.equal(privateIndexTarget({exchange:'BSE_INDEX',symbol:'NIFTY'}),null);
assert(saveIndexIntent(indexIntentFor('BSE_INDEX','SENSEX'),storage));
assert.equal(consumeIndexIntent(storage).symbol,'SENSEX');
const originalFetch=globalThis.fetch;
try {
  const blockedEvents=[];
  const blockedFeed=new QsynMarketsFeed(()=>{},{
    onBlockedIndex:item=>blockedEvents.push(item),
  });
  let blockedPrivateRequests=0;
  globalThis.fetch=async url=>{
    if(String(url).includes('/personal-index/history'))blockedPrivateRequests++;
    return {ok:false,status:401};
  };
  const indexReq={exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'};
  assert.deepEqual(await blockedFeed.getBars(indexReq),[],
    'anonymous homepage must not reveal Upstox candles');
  assert.equal(blockedPrivateRequests,0,
    'anonymous visitor cannot request Rust personal history without verified session');
  assert.equal(blockedEvents[0].symbol,'NIFTY');
  assert.equal(blockedEvents[0].exchange,'NSE_INDEX');
  assert.equal(blockedEvents.length,1);
  assert.deepEqual(await blockedFeed.getBars(indexReq),[]);
  assert.equal(blockedEvents.length,1,'blocked index state must not repeat');
  blockedFeed.destroy();

  let proofCalls=0,historyCalls=0,publicIndexRequests=0;
  const scoped=[];
  globalThis.fetch=async (url,opts)=>{
    if(String(url).includes('/india/bars')){publicIndexRequests++;throw Error('PUBLIC_INDEX_ENDPOINT_USED');}
    if(url==='/qsyn/api/v1/admin/upstox/index-history-proof'){
      proofCalls++;
      assert.equal(opts.credentials,'same-origin');
      return {ok:true,status:200,json:async()=>({
        schema:'QSYN-INDEX-HISTORICAL-PROOF/1',token_present:true,
        csrf:'a'.repeat(64),suggested_day_ist:'2026-10-09',
        trading_enabled:false
      })};
    }
    if(url==='/qsyn/api/v1/admin/upstox/personal-index/history'){
      historyCalls++;
      assert.equal(opts.method,'POST');
      assert.equal(opts.credentials,'same-origin');
      assert.equal(opts.headers['X-CSRF-Token'],'a'.repeat(64));
      const body=JSON.parse(opts.body);
      assert.deepEqual(Object.keys(body).sort(),['day','symbol']);
      scoped.push(body.symbol);
      const start=epoch(body.day+'T09:15:00+05:30');
      const bars=Array.from({length:375},(_,n)=>{
        const p=25000+n/10;
        return {time:start+n*60,open:p,high:p+2,low:p-2,close:p+1,volume:0};
      });
      return {ok:true,status:200,json:async()=>({
        schema:'QSYN-UPSTOX-RUST-INDEX-HISTORY/1',
        source:'upstox_v3_rust_history',
        symbol:body.symbol,day_ist:body.day,interval:'1m',
        bars,public_redistribution_allowed:false,trading_enabled:false
      })};
    }
    throw Error('UNEXPECTED_ENDPOINT_'+url);
  };
  const statuses=[],events=[];
  const authed=new QsynMarketsFeed(s=>statuses.push(s),{
    onBlockedIndex:item=>events.push(item)
  });
  const minute=await authed.getBars(indexReq);
  assert.equal(minute.length,375,'homepage must show entire authenticated Rust session');
  assert.equal(minute[0].time%60,0);
  assert.equal(minute[374].close,25000+374/10+1);
  assert.equal(historyCalls,1);
  assert.equal(proofCalls,1);
  assert.equal(publicIndexRequests,0);
  assert(events.some(item=>item===null),'personal chart must clear obsolete approval popup');
  const quarter=await authed.getBars({...indexReq,interval:'15m'});
  assert.equal(quarter.length,25,'15m homepage bars aggregate real Upstox 1m source');
  assert.equal(quarter[0].open,minute[0].open);
  assert.equal(quarter[0].close,minute[14].close);
  assert.equal(quarter[0].high,Math.max(...minute.slice(0,15).map(b=>b.high)));
  const hour=await authed.getBars({...indexReq,interval:'1h'});
  assert.equal(hour.length,7);
  assert.equal(hour[0].time,minute[0].time,'1h candles start at 09:15 IST');
  assert.equal(hour[0].close,minute[59].close);
  const daily=await authed.getBars({...indexReq,interval:'1d'});
  assert.equal(daily.length,1);
  assert(validIndexBarTime(daily[0].time,'1d'));
  assert.equal(daily[0].close,minute.at(-1).close);
  assert.deepEqual(await authed.getBarsPage({...indexReq,before:minute[0].time}),
    {bars:[],hasMore:false},'single private session must not page anonymous crypto API');
  const sensex=await authed.getBars({exchange:'BSE_INDEX:index',symbol:'SENSEX',interval:'1m'});
  assert.equal(sensex.length,375);
  assert(scoped.includes('NIFTY')&&scoped.includes('SENSEX'));
  const bankex=await authed.getBars({exchange:'BSE_INDEX:index',symbol:'BANKEX',interval:'1m'});
  assert.equal(bankex.length,375);
  assert(scoped.includes('BANKEX'));
  assert.deepEqual(await authed.getBars({exchange:'BSE_INDEX:index',symbol:'BANKEX',interval:'1s'}),[],
    'Upstox has no historical 1s BANKEX candles; live stream must supply updates');
  assert.equal(proofCalls,1,'one cached admin proof per browser feed instance');
  authed.destroy();
} finally {
  globalThis.fetch=originalFetch;
  feed.destroy();
}
console.log('PASS: private Rust 375-bar indices render on homepage only with QSYN administrator access');

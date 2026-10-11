import assert from 'node:assert/strict';
import { INDIA_INDEX_MARKETS,findIndiaIndex,searchIndiaIndexes } from '../src/india-index-catalog.js';
import { QsynMarketsFeed,validIndexBarTime } from '../src/qsyn-markets-feed.js';

const epoch=value=>Math.floor(Date.parse(value)/1000);
assert(validIndexBarTime(epoch('2026-10-09T09:15:00+05:30'),'1h'),'NSE 09:15 hourly bucket');
assert(validIndexBarTime(epoch('2026-10-09T00:00:00+05:30'),'1d'),'IST midnight daily bucket');
assert(!validIndexBarTime(epoch('2026-10-09T00:00:00Z'),'1d'),'UTC daily cannot replace IST daily');
assert(validIndexBarTime(epoch('2026-10-09T09:15:00+05:30'),'15m'),'IST intraday 15m alignment');
assert(!validIndexBarTime(epoch('2026-10-09T09:16:00+05:30'),'15m'),'reject misaligned minute');
assert.equal(INDIA_INDEX_MARKETS.length,6);
assert.equal(new Set(INDIA_INDEX_MARKETS.map(x=>x.id)).size,6);
assert.equal(findIndiaIndex('NSE_INDEX:index','NIFTY')?.name,'NIFTY 50');
assert.equal(findIndiaIndex('BSE_INDEX:index','SENSEX')?.name,'SENSEX');
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
assert.equal((await feed.searchSymbols({query:'bank nifty'}))[0].symbol,'BANKNIFTY');

const originalFetch=globalThis.fetch;
let cancellationCount=0;
try {
  globalThis.fetch=async ()=>{
    cancellationCount++;
    const err=new Error('The user aborted a request.');
    err.name='AbortError';
    throw err;
  };
  const abortFeed=new QsynMarketsFeed(()=>{},{indexAccessApproved:true});
  assert.deepEqual(await abortFeed.getBars({
    exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'
  }),[],'index abort must settle without an unhandled promise');
  assert.deepEqual(await abortFeed.getBars({
    exchange:'BINANCE:spot',symbol:'BTCUSDT',interval:'1m'
  }),[],'crypto abort must settle without an unhandled promise');
  assert.equal(cancellationCount,2);
  abortFeed.destroy();
} finally {globalThis.fetch=originalFetch;}

let calls=0;
try{
  globalThis.fetch=async url=>{
    calls++;
    assert(String(url).startsWith('/qsyn/api/v1/india/bars?'));
    assert(String(url).includes('symbol=NIFTY'));
    return {ok:false,status:503};
  };
  const index={exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'};
  assert.deepEqual(await feed.getBars(index),[]);
  assert.equal(calls,0,'public homepage must not even request unlicensed index bars');
  assert(status.at(-1).includes('authorization required'));
  assert.deepEqual(await feed.getBars(index),[]);
  assert.equal(calls,0,'locked index must never poll an unauthorized public route');

  // The full contract remains fail-closed even if a separately authorized
  // PRIVATE chart opts into request attempts; credentials are still checked
  // server-side and a 503 returns no fabricated NSE/BSE candles.
  const approved=new QsynMarketsFeed(s=>status.push(s),{indexAccessApproved:true});
  assert.deepEqual(await approved.getBars(index),[]);
  assert.equal(calls,1);
  assert.deepEqual(await approved.getBars(index),[]);
  assert.equal(calls,1,'permission denial must stop repeat queries per key');
  approved.destroy();

  // Even an accidentally misconfigured endpoint cannot inject demo candles
  // or unauthenticated data into an NSE/BSE index chart.
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({
    schema:'QSYN-LICENSED-INDIA-INDEX-BARS/1',
    source:'simulated',exchange:'BSE_INDEX',symbol:'SENSEX',
    interval:'1m',account_scoped:true,trading_enabled:false,
    public_redistribution_allowed:false,bars:[{
      time:1696982400,open:100,high:102,low:99,close:101,volume:1,
    }],
  })});
  const privateCandidate=new QsynMarketsFeed(s=>status.push(s),{indexAccessApproved:true});
  await assert.rejects(
    privateCandidate.getBars({exchange:'BSE_INDEX:index',symbol:'SENSEX',interval:'1m'}),
    /source\/entitlement validation failed/
  );
  privateCandidate.destroy();
}finally{
  globalThis.fetch=originalFetch;
  feed.destroy();
}
console.log('PASS: India indexes appear in native search; unlicensed candles fail closed');

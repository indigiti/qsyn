import assert from 'node:assert/strict';
import { INDIA_INDEX_MARKETS,findIndiaIndex,searchIndiaIndexes } from '../src/india-index-catalog.js';
import { QsynMarketsFeed } from '../src/qsyn-markets-feed.js';

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
  assert.equal(calls,1);
  assert(status.at(-1).includes('authorization required'));
  assert.deepEqual(await feed.getBars(index),[]);
  assert.equal(calls,1,'locked index must not repeatedly hit public route');

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
  await assert.rejects(
    feed.getBars({exchange:'BSE_INDEX:index',symbol:'SENSEX',interval:'1m'}),
    /source\/entitlement validation failed/
  );
}finally{
  globalThis.fetch=originalFetch;
  feed.destroy();
}
console.log('PASS: India indexes appear in native search; unlicensed candles fail closed');

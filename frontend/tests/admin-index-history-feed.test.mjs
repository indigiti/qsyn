import assert from 'node:assert/strict';
import {AdminIndexHistoryFeed} from '../src/admin-index-history-feed.js';
const ts=Math.floor(Date.now()/60000)*60-60;
const sample=[
 {time:ts-60,open:24001,high:24050,low:23980,close:24030,volume:0},
 {time:ts,open:24030,high:24060,low:24020,close:24040,volume:0},
];
const network=[];
const fetcher=async (url,opts)=>{
  network.push([url,opts]);
  return {ok:true,json:async()=>({
    schema:'QSYN-UPSTOX-ADMIN-INDEX-CANDLES/1',
    source:'upstox_authenticated_personal_history',
    exchange:'NSE_INDEX',symbol:'NIFTY',interval:'1m',
    provider_authenticated:true,live_socket_verified:false,
    public_redistribution_allowed:false,trading_enabled:false,
    bars:sample,
  })};
};
const feed=new AdminIndexHistoryFeed(()=>{},{fetcher});
const rows=await feed.getBars({
 exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'
});
assert.deepEqual(rows,sample);
assert.equal(network.length,1);
assert(network[0][0].startsWith('/qsyn/api/v1/admin/upstox/index-candles?'));
assert.equal(network[0][1].credentials,'same-origin');
assert.equal(network[0][1].headers.Accept,'application/json');
assert(!network[0][0].includes('Bearer'));
assert.equal((await feed.getBars({
 exchange:'NSE_INDEX:index',symbol:'MALICIOUS',interval:'1m'
})).length,0);
assert.equal(network.length,1);
const wrong=new AdminIndexHistoryFeed(()=>{},{
 fetcher:async()=>({ok:true,json:async()=>({
  schema:'QSYN-UPSTOX-ADMIN-INDEX-CANDLES/1',
  source:'upstox_authenticated_personal_history',
  exchange:'BSE_INDEX',symbol:'NIFTY',interval:'1m',
  provider_authenticated:true,live_socket_verified:false,
  public_redistribution_allowed:false,trading_enabled:false,
  bars:sample
 })})
});
assert.deepEqual(await wrong.getBars({exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'}),[],
 'provider with incorrect exchange must be rejected');
const fake=new AdminIndexHistoryFeed(()=>{},{
 fetcher:async()=>({ok:true,json:async()=>({
  schema:'QSYN-UPSTOX-ADMIN-INDEX-CANDLES/1',
  source:'simulated_exchange_prices',
  exchange:'NSE_INDEX',symbol:'NIFTY',interval:'1m',
  provider_authenticated:true,live_socket_verified:false,
  public_redistribution_allowed:false,trading_enabled:false,
  bars:sample
 })})
});
assert.deepEqual(await fake.getBars({exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'}),[],
 'do not show simulated candles as an index');
wrong.destroy();fake.destroy();feed.destroy();
console.log('PASS direct index source: personal admin API, valid OHLC only, no token/public routes');

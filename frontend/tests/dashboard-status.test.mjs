import assert from 'node:assert/strict';
import {fetchDashboardStatus,normalizeDashboardStatus}
  from '../src/dashboard-status.js';

const diagnostics={
  schema:'QSYN-ADMIN-DIAGNOSTICS/1',admin:{authenticated:true},
  trading_enabled:false,live_index_feed_verified:false,
};
const analytics={
  schema:'QSYN-UPSTOX-ANALYTICS-STATUS/1',
  token_stored:true,provider_feed_authorized_now:false,trading_enabled:false
};
const master={
  schema:'QSYN-UPSTOX-BOD-MASTER/1',
  catalog_ready:true,imported_day_ist:'2026-10-25',imported_today_ist:true,
  exchange_counts:{NSE:18234,BSE:13567},
  data_state:'discovery_only',history_verified:false,
  live_feed_verified:false,trading_enabled:false,
};
const safe=normalizeDashboardStatus({analytics,master,diagnostics});
assert.deepEqual(safe,{
  account:'stored',catalog:'ready',
  counts:{NSE:18234,BSE:13567},importDay:'2026-10-25',today:true,
  live:'unverified'
});
assert.equal(normalizeDashboardStatus({analytics,master,
  diagnostics:{...diagnostics,live_index_feed_verified:true}}).live,'verified');
assert.equal(normalizeDashboardStatus({
 analytics:{...analytics,token_stored:false},
 master:{...master,catalog_ready:false},
 diagnostics
}).account,'missing');
assert.equal(normalizeDashboardStatus({master:{...master,catalog_ready:false}}).catalog,'missing');
assert.equal(normalizeDashboardStatus({}).catalog,'unavailable');
assert.equal(normalizeDashboardStatus({analytics:{...analytics,trading_enabled:true}}).account,'unavailable');
assert.equal(normalizeDashboardStatus({master:{...master,history_verified:true}}).catalog,'unavailable');
assert.equal(normalizeDashboardStatus({
  master:{...master,exchange_counts:{NSE:'999',BSE:100}}
}).catalog,'unavailable');
assert.equal(normalizeDashboardStatus({
  diagnostics:{...diagnostics,admin:{authenticated:false},
  live_index_feed_verified:true}
}).live,'unavailable');

const urls=[];
const mock=async(url,opts)=>{
  urls.push({url,opts});
  const data=url.includes('analytics/status')?analytics:
    url.includes('mode=status')?master:diagnostics;
  return {ok:true,json:async()=>data};
};
const result=await fetchDashboardStatus({fetcher:mock});
assert.deepEqual(result,safe);
assert.equal(urls.length,3);
for(const entry of urls){
  assert.equal(entry.opts.credentials,'same-origin');
  assert.equal(entry.opts.cache,'no-store');
  assert.equal(entry.opts.headers.Accept,'application/json');
}
const partial=await fetchDashboardStatus({fetcher:async url=>{
  if(url.includes('analytics'))throw Error('disconnected');
  if(url.includes('mode=status'))return {ok:false,status:503};
  return {ok:true,json:async()=>diagnostics};
}});
assert.equal(partial.account,'unavailable');
assert.equal(partial.catalog,'unavailable');
assert.equal(partial.live,'unverified');
console.log('PASS: dashboard evidence is fail-closed and independent of browser feed switch');

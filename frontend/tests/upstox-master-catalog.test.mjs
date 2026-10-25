import assert from 'node:assert/strict';
import {masterParams,masterStatus,browseMaster,MASTER_ENDPOINT}
  from '../src/upstox-master-catalog.js';

const params=masterParams({exchange:'BSE',segment:'FO',type:'CE',query:'SENSEX',page:3});
assert.equal(params.get('exchange'),'BSE');
assert.equal(params.get('segment'),'FO');
assert.equal(params.get('page'),'3');
assert.throws(()=>masterParams({exchange:'MCX'}));
assert.throws(()=>masterParams({exchange:'NSE',query:'<script>'}));
assert.throws(()=>masterParams({exchange:'BSE',page:0}));
const status={
 schema:'QSYN-UPSTOX-BOD-MASTER/1',catalog_ready:true,
 imported_day_ist:'2026-10-25',imported_today_ist:true,
 exchange_counts:{NSE:1234,BSE:321},
 data_state:'discovery_only',history_verified:false,live_feed_verified:false,
 trading_enabled:false
};
const statusResult=await masterStatus({fetcher:async url=>{
  assert.equal(url,MASTER_ENDPOINT+'?mode=status');
  return {ok:true,json:async()=>status};
}});
assert.equal(statusResult.exchange_counts.NSE,1234);
const data={
 schema:'QSYN-UPSTOX-BOD-MASTER/1',
 source:'upstox_official_bod_json',data_state:'discovery_only',
 history_verified:false,live_feed_verified:false,trading_enabled:false,
 exchange:'BSE',segment:'FO',page_number:3,records:20,total_records:63,total_pages:4,
 instruments:[{instrument_key:'BSE_FO|1234',trading_symbol:'SENSEX CE',
  exchange:'BSE',segment:'BSE_FO',instrument_type:'CE',selection_scope:null}]
};
let options;
const result=await browseMaster({exchange:'BSE',segment:'FO',type:'CE',query:'SENSEX',page:3},
 {fetcher:async (url,opts)=>{assert(url.startsWith(MASTER_ENDPOINT+'?'));options=opts;
  return {ok:true,json:async()=>data};}});
assert.equal(result.instruments[0].instrument_key,'BSE_FO|1234');
assert.equal(options.credentials,'same-origin');
assert.equal(options.cache,'no-store');
await assert.rejects(browseMaster({exchange:'NSE'},{
 fetcher:async()=>({ok:true,json:async()=>({...data,history_verified:true})})
}),/Invalid NSE\/BSE master/);
await assert.rejects(browseMaster({exchange:'NSE'},{
 fetcher:async()=>({ok:false,status:409})
}),/not yet imported/);
console.log('PASS: NSE/BSE full master list browser never promotes discovery to market rights');

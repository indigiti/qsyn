import assert from 'node:assert/strict';
import {instrumentSearchParams,searchUpstoxInstruments,SEARCH_ENDPOINT}
  from '../src/upstox-instrument-search.js';
const good=instrumentSearchParams({query:'RELIANCE',exchange:'NSE',segment:'FO',
  type:'CE',expiry:'current_week',page:2});
assert.equal(good.get('query'),'RELIANCE');
assert.equal(good.get('exchanges'),'NSE');
assert.equal(good.get('segments'),'FO');
assert.equal(good.get('instrument_types'),'CE');
assert.equal(good.get('expiry'),'current_week');
assert.equal(good.get('page_number'),'2');
assert.throws(()=>instrumentSearchParams({query:'x'}));
assert.throws(()=>instrumentSearchParams({query:'NIFTY',exchange:'evil'}));
let requested;
const data={
 schema:'QSYN-UPSTOX-INSTRUMENT-SEARCH/1',source:'upstox_instrument_search_v2',
 data_state:'discovery_only',history_verified:false,live_feed_verified:false,
 trading_enabled:false,page_number:2,total_pages:4,
 instruments:[{instrument_key:'NSE_FO|157318',exchange:'NSE',
   segment:'NSE_FO',trading_symbol:'NIFTY 25000 CE',instrument_type:'CE'}]
};
const fetcher=async (url,opts)=>{requested={url,opts};return {ok:true,json:async()=>data}};
const found=await searchUpstoxInstruments({query:'NIFTY',page:2},{fetcher});
assert.equal(found.instruments[0].instrument_key,'NSE_FO|157318');
assert(requested.url.startsWith(SEARCH_ENDPOINT+'?'));
assert.equal(requested.opts.credentials,'same-origin');
assert.equal(requested.opts.cache,'no-store');
await assert.rejects(searchUpstoxInstruments({query:'NIFTY'},{fetcher:async()=>({
 ok:true,json:async()=>({...data,history_verified:true})
})}));
await assert.rejects(searchUpstoxInstruments({query:'NIFTY'},{fetcher:async()=>({
 ok:false,status:409
})}),/Analytics Token/);
console.log('PASS: authenticated paginated Upstox search never promotes discovery to verified data');

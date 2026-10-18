import assert from 'node:assert/strict';
import {PrivateUpstoxInstrumentHistoryFeed} from '../src/upstox-instrument-history-feed.js';
const instrument={instrument_key:'NSE_EQ|INE002A01018',selection_scope:'signed-selection'};
const originalFetch=globalThis.fetch;
let calls=0;
const now=Math.floor(Date.parse('2026-10-09T09:15:00+05:30')/1000);
try{
  globalThis.fetch=async(url,opts)=>{
    calls++;
    assert.equal(url,'/qsyn/api/v1/admin/upstox/instruments/history');
    assert.equal(opts.method,'POST');
    assert.equal(opts.credentials,'same-origin');
    assert.equal(opts.headers['X-CSRF-Token'],'csrf-local');
    assert.deepEqual(JSON.parse(opts.body),{scope:'signed-selection',day:'2026-10-09'});
    return {ok:true,status:200,json:async()=>({
      schema:'QSYN-UPSTOX-INSTRUMENT-HISTORY/1',
      source:'upstox_v3_private_instrument_history',
      instrument_key:instrument.instrument_key,day_ist:'2026-10-09',
      interval:'1m',trading_enabled:false,public_redistribution_allowed:false,
      live_feed_verified:false,
      bars:[{time:now,open:100,high:102,low:99,close:101,
        volume:150,volume_available:true,open_interest:2500}]
    })};
  };
  const updates=[];
  const feed=new PrivateUpstoxInstrumentHistoryFeed({
    instrument,day:'2026-10-09',csrf:'csrf-local',onStatus:s=>updates.push(s)});
  const q={exchange:'UPSTOX_SCOPED',symbol:instrument.instrument_key,interval:'1m'};
  assert.equal((await feed.getBars(q))[0].volume,150);
  assert.equal((await feed.getBars(q))[0].open_interest,2500);
  assert.equal(calls,1,'same day is cached');
  assert.deepEqual(await feed.getBars({...q,symbol:'OTHER'}),[]);
  assert.equal(typeof feed.subscribeBars(q,()=>{}),'function');
  assert.match(updates[0],/provider-backed/);
  feed.destroy();
  assert.deepEqual(await feed.getBars(q),[]);
  const second=new PrivateUpstoxInstrumentHistoryFeed({
    instrument,day:'2026-10-09',csrf:'csrf-local'});
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({
    schema:'QSYN-UPSTOX-INSTRUMENT-HISTORY/1',
    source:'upstox_v3_private_instrument_history',
    instrument_key:instrument.instrument_key,day_ist:'2026-10-09',
    interval:'1m',trading_enabled:false,public_redistribution_allowed:false,
    live_feed_verified:false,
    bars:[{time:now,open:100,high:102,low:99,close:101,
      volume:30,volume_available:false,open_interest:null}]
  })});
  await assert.rejects(second.getBars({...q,strictHistory:true}),
    /UPSTOX_INSTRUMENT_CANDLE_INVALID/);
  second.destroy();
}finally{globalThis.fetch=originalFetch;}
console.log('PASS: instrument history uses signed scope; only source-backed volume and OI');

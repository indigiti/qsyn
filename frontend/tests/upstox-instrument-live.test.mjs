import assert from 'node:assert/strict';
import {validScopedLive} from '../src/upstox-instrument-history-feed.js';
const key='NSE_FO|157318',now=1_798_200_000_000,minute=Math.floor(now/60000)*60;
const sample={schema:'QSYN-RUST-UPSTOX-INSTRUMENT-LIVE/1',
 source:'upstox_v3_full_provider_ohlc',instrument_key:key,
 provider_time_ms:now,volume_available:true,open_interest:1200,trading_enabled:false,
 bar:{time:minute,open:100,high:102,low:99,close:101,volume:55}};
assert(validScopedLive(sample,key));
assert(!validScopedLive({...sample,volume_available:false},key));
assert(!validScopedLive({...sample,source:'synthetic'},key));
assert(!validScopedLive({...sample,bar:{...sample.bar,volume:-1}},key));
assert(!validScopedLive({...sample,bar:{...sample.bar,high:99}},key));
assert(!validScopedLive(sample,key,minute,56));
assert(!validScopedLive({...sample,instrument_key:'OTHER'},key));
assert(!validScopedLive({...sample,provider_time_ms:now-180000},key));
console.log('PASS provider-only full-mode Upstox OHLCV live data');

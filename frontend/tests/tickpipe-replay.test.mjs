import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeReplay,advanceReplay} from '../src/tickpipe-replay.js';
const bar={time:Date.parse('2026-11-19T03:45:00Z')/1000,open:100,high:101,low:99,close:101};
const bundle={schema:'QSYN-TICKPIPE-REPLAY/1',source:'openalgo_snapshot',mode:'offline_only',
  candle_clock:'receive_time_utc',symbol:'NFO:NIFTY',date_utc:'2026-11-19',sequence_gaps:[['5','6']],
  candles:{1:[bar,{...bar,time:bar.time+2}],60:[bar]}};
test('decodes valid candles without inserting absent seconds',()=>{
  const data=decodeReplay(JSON.stringify(bundle));
  assert.equal(data.gaps,1);
  assert.deepEqual(data.candles[1].map(b=>b.time),[bar.time,bar.time+2]);
  assert.equal(advanceReplay(2,2),2);
});
test('rejects untrusted provenance, duplicate buckets and invalid OHLC',()=>{
  for(const value of [
    {...bundle,mode:'live'},
    {...bundle,candles:{1:[bar,bar],60:[bar]}},
    {...bundle,candles:{1:[{...bar,low:102}],60:[bar]}},
  ])assert.throws(()=>decodeReplay(JSON.stringify(value)));
});

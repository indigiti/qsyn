import assert from 'node:assert/strict';
import {aggregatePersonalIndexBars,latestPersonalIndexBar} from '../src/qsyn-markets-feed.js';

// Cover partial buckets, revised live minutes, session boundaries and bounded
// history windows without introducing synthetic bars or changing timestamps.
const start=Math.floor(Date.parse('2026-10-09T09:15:00+05:30')/1000);
const minute=(i,close=i+100)=>({
  time:start+i*60,open:100+i,high:Math.max(102+i,close),
  low:Math.min(99+i,close),close,volume:1+i
});
const check=(bars,interval)=>{
  const expected=aggregatePersonalIndexBars(bars,interval).at(-1)??null;
  assert.deepEqual(latestPersonalIndexBar(bars,interval),expected,
    interval+' last active bucket must match full historical aggregation');
};
for(const interval of ['1m','5m','15m','1h','1d']){
  check([],interval);
  for(let n=1;n<=405;n+=1){
    const bars=Array.from({length:n},(_,i)=>minute(i));
    check(bars,interval);
  }
  const revised=Array.from({length:395},(_,i)=>minute(i));
  revised[394]=minute(394,700);
  check(revised,interval);
  check(revised.slice(30),interval);
  const nextDay=Math.floor(Date.parse('2026-10-12T09:15:00+05:30')/1000);
  check([...revised,{...minute(0),time:nextDay}],interval);
}
assert.throws(()=>latestPersonalIndexBar([], '2m'),/INVALID_INDEX_INTERVAL/);
console.log('PASS: streaming index candle fast path matches historical aggregation across boundaries');

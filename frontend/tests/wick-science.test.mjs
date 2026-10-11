import assert from 'node:assert/strict';
import {calculateWickScience} from '../src/wick-science-core.js';

// 20 completed 3-minute setup candles; 1-minute chart; exact 2pt MFE
// history -> 1.6pt zones with 80% fraction.
const base=1_700_000_100; // deliberately normalize to an exact 3m boundary
const start=Math.floor(base/180)*180;
const bars=[];
for(let setup=0;setup<20;setup++){
  for(let sub=0;sub<3;sub++){
    bars.push({time:start+setup*180+sub*60,open:100,high:sub===0?102:101,
      low:sub===1?98:99,close:100});
  }
}
const t=start+20*180;
bars.push(
  {time:t,open:100,high:102,low:99,close:101}, // arm short
  {time:t+60,open:101,high:102,low:99,close:99}, // SELL flip at setup open
  {time:t+120,open:99,high:100,low:98,close:98.5}, // TP
  {time:t+180,open:100,high:100,low:100,close:100}, // next setup
);
const opts={setupTf:'3',samples:20,reachRate:80,zoneFraction:80,slBuffer:2};
const context={interval:'1m',tickSize:.05,lastConfirmed:false};
const v=calculateWickScience(bars,opts,context).values;
assert.equal(v.setupOpen[60],100);
assert.ok(Math.abs(v.upperZone[60]-101.6)<1e-9);
assert.ok(Math.abs(v.lowerZone[60]-98.4)<1e-9);
assert.equal(v.shortArmed[60],1);
assert.equal(v.shortEntry[61],1);
assert.ok(Math.abs(v.activeStop[61]-102.1)<1e-9);
assert.equal(v.shortTP[62],1);
assert.equal(v.activeStop[62],null);
assert.equal(v.longEntry[61],null);

const unavailable=calculateWickScience(bars,opts,{...context,interval:'3m'});
assert.equal(unavailable.reason,'chart_timeframe_must_be_lower');
assert.ok(unavailable.values.shortEntry.every(x=>x===null));
const noTick=calculateWickScience(bars,opts,{interval:'1m'});
assert.equal(noTick.reason,'instrument_tick_size_unavailable');
assert.ok(noTick.values.shortEntry.every(x=>x===null));

// OHLC cannot order the two extrema inside one one-minute candle.
const ambiguous=bars.map(x=>({...x}));
ambiguous[60]={...ambiguous[60],high:102,low:98};
let a=calculateWickScience(ambiguous,opts,context).values;
assert.equal(a.shortEntry[61],null);
assert.equal(a.longEntry[61],null);

// The entry bar cannot also resolve its TP/SL. If both subsequent extrema
// touch in one bar, stop takes priority, as in the original Pine script.
const both=bars.map(x=>({...x}));
both[62]={...both[62],high:103,low:97};
const b=calculateWickScience(both,opts,context).values;
assert.equal(b.shortSL[62],1);
assert.equal(b.shortTP[62],null);

// No new signal on unconfirmed forming tail.
const forming=bars.slice(0,61);
const f=calculateWickScience(forming,opts,context).values;
assert.equal(f.shortArmed[60],null);

// Missing candles do not contribute to the statistical lookback.
const missing=bars.filter((_,i)=>i!==1);
const m=calculateWickScience(missing,opts,context);
assert.ok(m.values.upperZone.every(x=>x===null));
console.log('Wick Science MFE state machine: PASS');

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
assert.ok(noTick.values.shortEntry.every(x=>x===null),
  'no unsupported stop or entry signal without verified instrument tick');
assert.equal(noTick.values.setupOpen[60],100,'MFE open is tick-independent');
assert.ok(Math.abs(noTick.values.upperZone[60]-101.6)<1e-9,
  'missing tick metadata must never hide upper MFE zone');
assert.ok(Math.abs(noTick.values.lowerZone[60]-98.4)<1e-9);
assert.equal(noTick.values.shortArmed[60],1,
  'non-executable MFE touch marker does not require stop tick metadata');
assert(noTick.values.activeStop.every(x=>x===null));
const explicitTick=calculateWickScience(bars,opts,{interval:'1m',tickSize:0.01});
assert.equal(explicitTick.reason,null);
assert.equal(explicitTick.values.shortEntry[61],1,
  'verified tick metadata or explicit positive override enables full trade states');

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

// A dropped bar inside the active setup invalidates the entire flip path:
// the otherwise qualifying 3rd one-minute candle cannot manufacture a trade.
const inSetupGap=bars.filter((_,i)=>i!==61).map(x=>({...x}));
inSetupGap[61]={...inSetupGap[61],open:101,high:102,low:99,close:99};
const invalidated=calculateWickScience(inSetupGap,opts,context).values;
assert.equal(invalidated.shortArmed[60],1);
assert.equal(invalidated.shortEntry[61],null);
assert.equal(invalidated.longEntry[61],null);

// No new signal on unconfirmed forming tail.
const forming=bars.slice(0,61);
const f=calculateWickScience(forming,opts,context).values;
assert.equal(f.shortArmed[60],null);

// Missing candles do not contribute to the statistical lookback.
const missing=bars.filter((_,i)=>i!==1);
const m=calculateWickScience(missing,opts,context);
// 19 intact prior setup candles are not enough; after another full setup
// candle, the history rewarms and zones may legitimately return.
assert.ok(m.values.upperZone.slice(0,-1).every(x=>x===null));
assert.ok(Number.isFinite(m.values.upperZone.at(-1)));

// Long reversal must use the same cross-open confirmation and opposite target.
const longBars=bars.map(x=>({...x}));
longBars[60]={...longBars[60],open:100,high:101,low:97,close:99};
longBars[61]={...longBars[61],open:99,high:101,low:98,close:101};
longBars[62]={...longBars[62],open:101,high:102,low:99,close:102};
const l=calculateWickScience(longBars,opts,context).values;
assert.equal(l.longArmed[60],1);
assert.equal(l.longEntry[61],1);
assert.ok(Math.abs(l.activeStop[61]-96.9)<1e-9);
assert.equal(l.longTP[62],1);
assert.equal(l.longSL[62],null);
assert.equal(l.shortEntry[61],null);
// BTC/ETH charts often have 1600+ 1m bars and a price scale whose
// unconfigured minMove is 0. A provider gap or an incomplete 5m group must
// not erase the last 100 genuinely completed 5m MFE samples.
const btcBars=[];
const fiveStart=Math.floor(1_790_000_000/300)*300;
for(let setup=0;setup<110;setup++){
  for(let sub=0;sub<5;sub++){
    btcBars.push({time:fiveStart+setup*300+sub*60,
      open:82000,high:82020,low:81980,close:82000});
  }
}
// A partial setup group (only 3 recorded minutes) is NOT a completed MFE.
for(let sub=0;sub<3;sub++)btcBars.push({
  time:fiveStart+110*300+sub*60,open:82000,high:82020,low:81980,close:82000
});
const afterGap=fiveStart+112*300; // a completely missing 5m group
for(let sub=0;sub<5;sub++)btcBars.push({
  time:afterGap+sub*60,open:82000,high:82020,low:81980,close:82000
});
const gapResult=calculateWickScience(btcBars,{
  setupTf:'5',samples:100,reachRate:80,zoneFraction:80,slBuffer:2
},{interval:'1m'});
assert.equal(gapResult.reason,'instrument_tick_size_unavailable');
assert.ok(Number.isFinite(gapResult.values.upperZone.at(-1)),
  'completed MFE history must survive a partial provider candle and market gap');
assert.ok(Number.isFinite(gapResult.values.lowerZone.at(-1)));
assert(gapResult.values.upperZone.at(-1)>gapResult.values.setupOpen.at(-1));
assert(gapResult.values.lowerZone.at(-1)<gapResult.values.setupOpen.at(-1));

// Indian index 1m history is 375 bars per session: the 5m/100 sample window
// must warm across consecutive genuine sessions, not at every market open.
const sessionBars=[];
for(const day of ['2026-10-08','2026-10-09','2026-10-12']){
  const start=Math.floor(Date.parse(day+'T09:15:00+05:30')/1000);
  for(let i=0;i<375;i++)sessionBars.push({
    time:start+i*60,open:22300,high:22305,low:22295,close:22300
  });
}
const sessionResult=calculateWickScience(sessionBars,{
  setupTf:'5',samples:100,reachRate:80,zoneFraction:80,slBuffer:2
},{interval:'1m'});
assert.ok(Number.isFinite(sessionResult.values.upperZone.at(-1)),
  'NIFTY MFE history must span exchange trading sessions');
assert.ok(Number.isFinite(sessionResult.values.lowerZone.at(-1)));

console.log('Wick Science MFE state machine, crypto gaps and NSE sessions: PASS');

import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePremiumCsv,replayPremiumStrategy,validatePremiumRules,PREMIUM_PRESET} from '../src/premium-breakout-core.js';

const at=(day,i)=>Date.parse(day+'T09:15:00+05:30')+i*60000;
const bar=(i,o,h,l,c,volume=100,oi=1000,day='2026-10-12')=>
  ({time:at(day,i),open:o,high:h,low:l,close:c,volume,oi});
const csv=bars=>'time,open,high,low,close,volume,oi\n'+bars.map(b=>
  [new Date(b.time).toISOString(),b.open,b.high,b.low,b.close,b.volume,b.oi??''].join(',')).join('\n');

test('strict offset-aware 1-minute CSV, no intraday gaps, allow overnight/weekends',()=>{
  const b=[bar(0,394,400,390,398),bar(1,399,408,397,405),bar(2,408,410,401,408)];
  assert.equal(parsePremiumCsv(csv(b)).length,3);
  assert.throws(()=>parsePremiumCsv(csv([b[0],b[2]])),/Missing\/noncontiguous/);
  assert.throws(()=>parsePremiumCsv('time,open,high,low,close,volume\n2026-10-12T09:15,1,2,1,1,1\n2026-10-12T09:16,1,2,1,1,1'),/offset/);
  assert.throws(()=>parsePremiumCsv(csv([bar(0,394,400,390,398),bar(1,400,410,415,405)])),/Invalid OHLCV/);
  assert.equal(parsePremiumCsv(csv([bar(0,395,396,394,395,100,100,'2026-10-09'),b[0]])).length,2);
});

test('long signal uses prior completed close; stop prioritized in ambiguous OHLC',()=>{
 const b=[bar(0,399,401,398,400),bar(1,400,405,399,403),
 bar(2,405,470,380,440),bar(3,440,444,437,438)];
 const result=replayPremiumStrategy(b);
 assert.equal(result.trades.length,1);
 assert.equal(result.trades[0].entry,405);
 assert.equal(result.trades[0].exit,386);
 assert.equal(result.trades[0].exitReason,'STOP');
 assert.equal(result.trades[0].points,-19);
 assert.equal(result.summary.wins,0);
});

test('half target and following candle trailing exit produce half-weighted points',()=>{
 const b=[bar(0,399,401,398,400),bar(1,400,405,399,403),
 bar(2,404,480,402,470),bar(3,470,472,399,420)];
 const r=replayPremiumStrategy(b,{...PREMIUM_PRESET,partialR:3});
 assert.equal(r.trades.length,1);
 assert.equal(r.trades[0].firstExit,458);
 assert.equal(r.trades[0].exit,402);
 assert.equal(r.trades[0].points,26);
 assert.ok(Math.abs(r.trades[0].r-26/18)<1e-9);
});

test('short side and conditional volume / rising-OI filters',()=>{
 const b=[bar(0,395,396,390,391,10,100),bar(1,390,391,382,384,10,90),
 bar(2,380,381,360,365,100,80),bar(3,365,368,364,366,100,70)];
 const r=replayPremiumStrategy(b);
 assert.equal(r.openPosition?.side,'SHORT');
 assert.equal(r.openPosition?.entry,380);
 assert.equal(replayPremiumStrategy(b,{...PREMIUM_PRESET,useOi:true}).openPosition,null);
 assert.equal(replayPremiumStrategy(b,{...PREMIUM_PRESET,useVolume:true,volumeLookback:5}).openPosition,null);
});

const previousSession=()=>Array.from({length:375},(_,i)=>
  bar(i,395,396,394,395,100,1000,'2026-10-09'));
const nextSession=()=>[
  bar(0,399,401,398,400),bar(1,400,405,399,403),
  bar(2,404,411,403,409),bar(3,409,412,407,410)
];

test('auto previous-session low derives 402/386 only after a complete past session',()=>{
 const b=[...previousSession(),...nextSession()];
 const r=replayPremiumStrategy(b,{...PREMIUM_PRESET,mode:'PREVIOUS_LOW'});
 assert.equal(r.levels[0].source,'unavailable');
 assert.deepEqual([r.levels[1].buyAbove,r.levels[1].shortBelow],[402,386]);
 assert.equal(r.levels[1].referenceDate,'2026-10-09');
 assert.equal(r.openPosition?.side,'LONG');
 assert.equal(r.openPosition?.entry,404);
 const incomplete=[...previousSession().slice(1),...nextSession()];
 const rejected=replayPremiumStrategy(incomplete,{...PREMIUM_PRESET,mode:'PREVIOUS_LOW'});
 assert.equal(rejected.levels[1].source,'unavailable');
 assert.equal(rejected.openPosition,null);
});

test('previous range mode derives bounded high/low, without future leakage',()=>{
 const r=replayPremiumStrategy([...previousSession(),...nextSession()],
   {...PREMIUM_PRESET,mode:'PREVIOUS_RANGE',autoBuffer:8});
 assert.equal(r.levels[1].buyAbove,404);
 assert.equal(r.levels[1].shortBelow,386);
 assert.equal(r.openPosition,null); // no cross above 404: 403 < 404
});

function synthTrend(decline=true,includeNew=true) {
 const prev=Array.from({length:375},(_,i)=>{
   const v=(decline?22700-i*0.2:22000+i*0.2);
   return bar(i,v,v+1,v-1,v,200,null,'2026-10-09');
 });
 const cur=Array.from({length:4},(_,i)=>{
   const v=(decline?22625-i*0.2:22075+i*0.2);
   return bar(i,v,v+1,v-1,v,200,null,'2026-10-12');
 });
 return [...prev,...(includeNew?cur:[])];
}
test('optional synthetic EMA21/90 confirms bearish PE buy, rejects bullish and missing data',()=>{
 const source=[...previousSession(),...nextSession()];
 const rules={...PREMIUM_PRESET,mode:'PREVIOUS_LOW',trendMode:'EMA21_90'};
 assert.equal(replayPremiumStrategy(source,rules,synthTrend(true)).openPosition?.side,'LONG');
 assert.equal(replayPremiumStrategy(source,rules,synthTrend(false)).openPosition,null);
 assert.equal(replayPremiumStrategy(source,rules,synthTrend(true,false)).openPosition,null);
 assert.throws(()=>replayPremiumStrategy(source,rules),/Import time-aligned/);
});

test('trade stays unverified when supplied data end before exit',()=>{
 const r=replayPremiumStrategy([bar(0,399,401,398,400),bar(1,400,405,399,403),bar(2,404,411,403,409)]);
 assert.equal(r.summary.completed,0);
 assert.ok(r.openPosition);
});
test('invalid thresholds, modes and stop direction rejected',()=>{
 assert.throws(()=>validatePremiumRules({...PREMIUM_PRESET,buyStop:402}),/Long stop/);
 assert.throws(()=>validatePremiumRules({...PREMIUM_PRESET,directions:'ORDERS'}),/Unsupported/);
 assert.throws(()=>validatePremiumRules({...PREMIUM_PRESET,mode:'FUTURE'}),/Unsupported/);
});

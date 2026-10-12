import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePremiumCsv,replayPremiumStrategy,validatePremiumRules,PREMIUM_PRESET} from '../src/premium-breakout-core.js';

const at=i=>new Date(Date.parse('2026-10-12T09:15:00+05:30')+i*60000).toISOString();
const bar=(i,o,h,l,c,volume=100,oi=1000)=>({time:Date.parse(at(i)),open:o,high:h,low:l,close:c,volume,oi});
const csv=(bars)=>'time,open,high,low,close,volume,oi\n'+bars.map(b=>
  [new Date(b.time).toISOString(),b.open,b.high,b.low,b.close,b.volume,b.oi].join(',')).join('\n');

test('strict offset-aware one-minute CSV and valid OHLCV',()=>{
 const bars=[bar(0,394,400,390,398),bar(1,399,408,397,405),bar(2,408,410,401,408)];
 assert.equal(parsePremiumCsv(csv(bars)).length,3);
 assert.throws(()=>parsePremiumCsv(csv([bars[0],bars[2]])),/contiguous/);
 assert.throws(()=>parsePremiumCsv('time,open,high,low,close,volume\n2026-10-12T09:15,1,2,1,1,1\n2026-10-12T09:16,1,2,1,1,1'),/offset/);
 assert.throws(()=>parsePremiumCsv(csv([bar(0,394,400,390,398),bar(1,400,410,415,405)])),/Invalid OHLCV/);
});

test('long trigger uses completed bar, executes next open; stop has conservative priority',()=>{
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

test('half booking, stop and weighted points accounted, no fee claims',()=>{
 const b=[bar(0,399,401,398,400),bar(1,400,405,399,403),
 bar(2,404,480,402,470),bar(3,470,472,399,420)];
 const r=replayPremiumStrategy(b,{...PREMIUM_PRESET,partialR:3});
 assert.equal(r.trades.length,1);
 assert.equal(r.trades[0].firstExit,458);
 assert.equal(r.trades[0].exit,386);
 assert.equal(r.trades[0].points,18);
 assert.equal(r.trades[0].r,1);
});

test('short side, volume and OI are optional gates; insufficient history cannot pass',()=>{
 const b=[bar(0,395,396,390,391,10,100),bar(1,390,391,382,384,10,90),
 bar(2,380,381,360,365,100,80),bar(3,365,368,364,366,100,70)];
 const r=replayPremiumStrategy(b);
 assert.equal(r.openPosition?.side,'SHORT');
 assert.equal(r.openPosition?.entry,380);
 const gated=replayPremiumStrategy(b,{...PREMIUM_PRESET,useOi:true});
 assert.equal(gated.trades.length,0);
 assert.equal(gated.openPosition,null);
 const volume=replayPremiumStrategy(b,{...PREMIUM_PRESET,useVolume:true,volumeLookback:5});
 assert.equal(volume.openPosition,null);
});
test('invalid threshold and direction rejected',()=>{
 assert.throws(()=>validatePremiumRules({...PREMIUM_PRESET,buyStop:402}),/Stops/);
 assert.throws(()=>validatePremiumRules({...PREMIUM_PRESET,directions:'ORDERS'}),/limits/);
});

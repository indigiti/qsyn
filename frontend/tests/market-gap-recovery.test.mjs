import assert from 'node:assert/strict';
import {QsynCryptoFeed,MAX_AUTO_BACKFILL_BARS} from '../src/crypto-feed.js';
import {QsynMarketsFeed,aggregatePersonalIndexBars} from '../src/qsyn-markets-feed.js';
import {findIndiaIndex} from '../src/india-index-catalog.js';
import {findProviderGaps,mergeProviderGapBars,shouldAttemptGap,
  GAP_REPAIR_COOLDOWN_MS} from '../src/market-gap-recovery.js';

// Every inserted OHLC must come from a strictly verified provider response.
// No gap is filled from a previous close, zero volume or interpolation.
const makeBar=(time,price=100)=>({time,open:price,high:price+2,
  low:price-2,close:price+1,volume:2});
const stepByInterval={'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400};
const epoch=s=>Math.floor(Date.parse(s)/1000);
const fri=epoch('2026-10-09T09:15:00+05:30');
const mon=epoch('2026-10-12T09:15:00+05:30');
const session=[makeBar(fri),makeBar(fri+60*3)];
assert.equal(findProviderGaps(session,60,{index:true})[0].missing,2);
assert.equal(findProviderGaps([makeBar(fri+374*60),makeBar(mon)],60,
  {index:true}).length,0,'overnight/holiday/weekend is not a gap');
assert.equal(findProviderGaps([makeBar(fri+374*60),makeBar(fri+375*60)],60,
  {index:true}).length,0,'after-hours is not a missing regular-session candle');
assert.equal(findProviderGaps(session,300,{index:true}).length,0);
assert.deepEqual(mergeProviderGapBars(session,[makeBar(fri+60,120),
  makeBar(fri+120,140)],60,{index:true}).map(x=>x.time),
  [fri,fri+60,fri+120,fri+180]);
assert.deepEqual(mergeProviderGapBars(session,[makeBar(fri+60,120)],60,
  {index:true})[1].close,121);
const attempts=new Map();
assert(shouldAttemptGap(attempts,'test',1000));
assert(!shouldAttemptGap(attempts,'test',1000+GAP_REPAIR_COOLDOWN_MS-1));
assert(shouldAttemptGap(attempts,'test',1000+GAP_REPAIR_COOLDOWN_MS));

const realFetch=globalThis.fetch;
try {
  // Crypto: historical pagination initially omits one exchange candle; the
  // targeted exclusive-cursor replay can recover it from the same source.
  for(const [interval,step] of Object.entries(stepByInterval)){
    const latest=Math.floor(Date.now()/1000/step)*step;
    const all=Array.from({length:1610},(_,i)=>
      makeBar(latest-(1609-i)*step,i+100));
    const target=all[all.length-45];
    const sparse=all.filter(bar=>bar.time!==target.time);
    let probeCount=0,endpointCalls=0;
    globalThis.fetch=async url=>{
      const u=new URL(String(url),'https://qsyn.test');
      assert.equal(u.pathname,'/qsyn/api/v1/crypto/bars');
      const before=u.searchParams.has('before')?
        Number(u.searchParams.get('before')):null;
      const limit=Number(u.searchParams.get('limit'));
      const replay=before===target.time+step&&limit===2;
      endpointCalls++;
      if(replay)probeCount++;
      const collection=replay?all:sparse;
      const bars=(before===null?collection:collection.filter(x=>x.time<before))
        .slice(-limit);
      return {ok:true,json:async()=>({
        schema:'QSYN-PUBLIC-CRYPTO-BARS/1',source:'exchange_public',
        exchange:'BINANCE',market:'spot',symbol:'BTCUSDT',interval,
        trading_enabled:false,bars,
        pagination:{before,next_before:bars[0]?.time??null,
          has_more:bars.length===limit}
      })};
    };
    const feed=new QsynCryptoFeed();
    const request={exchange:'BINANCE:spot',symbol:'BTCUSDT',interval};
    const recovered=await feed.getBars(request);
    assert.equal(recovered.length,1600,interval+' respects history memory budget');
    assert(recovered.some(bar=>bar.time===target.time),interval+' missing candle recovered');
    assert.equal(new Set(recovered.map(x=>x.time)).size,recovered.length);
    assert.equal(probeCount,1,interval+' one targeted gap replay');
    const beforeSecond=probeCount;
    await feed.getBars(request);
    assert.equal(probeCount,beforeSecond,'gap retry is not reissued once recovered');
    assert(endpointCalls<20,'initial pagination and repair are bounded');
    feed.destroy();
    assert.equal(MAX_AUTO_BACKFILL_BARS,15016);
  }

  // Indices: read-only, same-session 1m replay restores a genuine gap BEFORE
  // deriving all 5m/15m/1h/1d candles; it never manufactures a candle.
  let dayFetches=0,ownerChecks=0;
  globalThis.fetch=async (url,opts={})=>{
    if(url==='/qsyn/api/v1/owner-index/status'){
      ownerChecks++;
      return {ok:true,json:async()=>({
        schema:'QSYN-PERSONAL-INDEX-OWNER-VIEWER/1',
        access:'owner-ip-allowlist',trading_enabled:false,
        public_redistribution_allowed:false,suggested_day_ist:'2026-10-09',
        symbols:['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','SENSEX','BANKEX','NIFTYNXT50']
      })};
    }
    assert.equal(url,'/qsyn/api/v1/owner-index/history');
    assert.equal(opts.headers['X-QSYN-View-Only'],'1');
    const body=JSON.parse(opts.body);
    dayFetches++;
    const start=epoch(body.day+'T09:15:00+05:30');
    const full=Array.from({length:375},(_,i)=>makeBar(start+i*60,100+i));
    const bars=dayFetches===1?full.filter((_,i)=>i!==18):full;
    return {ok:true,json:async()=>({
      schema:'QSYN-UPSTOX-RUST-INDEX-HISTORY/1',
      source:'upstox_v3_rust_history',
      symbol:body.symbol,day_ist:body.day,interval:'1m',bars,
      trading_enabled:false,public_redistribution_allowed:false
    })};
  };
  const idx=new QsynMarketsFeed();
  const req={exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'};
  const restored=await idx.getBars(req);
  assert.equal(restored.length,375,'provider replay restored one genuine index minute');
  assert.equal(restored[18].time-restored[17].time,60);
  assert.equal(dayFetches,2,'initial session load plus one guarded day replay');
  assert.equal(ownerChecks,1,'read-only owner grant reused');
  for(const interval of ['5m','15m','1h','1d']){
    const result=await idx.getBars({...req,interval});
    assert.deepEqual(result,aggregatePersonalIndexBars(restored,interval),
      interval+' derived entirely from verified 1m candles');
  }
  assert.equal(dayFetches,6,'following intervals reuse recovered day without extra replay');
  idx.destroy();

  // Live index socket: a minute jump may trigger ONE day replay and native
  // history resync; all real streamed OHLC still goes straight to onBar.
  const live=new QsynMarketsFeed();
  const instrument=findIndiaIndex('NSE_INDEX:index','NIFTY');
  let handler=null,liveReplay=0,resync=0,updates=0;
  live.personalFeeds.set(instrument.id,{day:'2026-10-09',
    subscribeBars:(_req,onBar)=>{handler=onBar;return ()=>{};},
    destroy:()=>{}});
  live.personalBars.set(instrument.id,[makeBar(fri)]);
  live._proof=async()=>({ownerViewer:true,csrf:null});
  live._historicalDay=async()=>{
    liveReplay++;
    return [makeBar(fri),makeBar(fri+60),makeBar(fri+120),makeBar(fri+180)];
  };
  const stop=live.subscribeBars(req,()=>{updates++;},
    {onResync:()=>{resync++;}});
  handler(makeBar(fri+180));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(updates,1,'real live update delivered immediately');
  assert.equal(liveReplay,1,'one verified provider day replay');
  assert.equal(resync,1,'native chart requested to reload recovered history');
  assert.equal(live.personalBars.get(instrument.id).length,4);
  stop();live.destroy();
  console.log('PASS: provider-only automatic gap recovery on all 1m+ intervals');
} finally {
  globalThis.fetch=realFetch;
}

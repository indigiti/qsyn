import assert from 'node:assert/strict';
import {QsynCryptoFeed,MAX_AUTO_BACKFILL_BARS,INITIAL_BACKFILL_BARS} from '../src/crypto-feed.js';
import {wickRequiredBars,observeWickScienceBackfill} from '../src/wick-science-auto-backfill.js';
import {WICK_SCIENCE_ID} from '../src/wick-science-core.js';

// Backfill mocks a provider with genuine validated, sorted OHLCV pages, not
// synthetic fallback inside the implementation under test.
const now=Math.floor(Date.now()/60000)*60;
const all=Array.from({length:15500},(_,i)=>({
  time:now-(15500-i-1)*60,open:100,high:102,low:99,close:101,volume:1
}));
const original=globalThis.fetch;
const seen=[];
globalThis.fetch=async url=>{
  const u=new URL(String(url),'https://qsyn.invalid');
  assert.equal(u.pathname,'/qsyn/api/v1/crypto/bars');
  assert.equal(u.searchParams.get('exchange'),'BINANCE');
  assert.equal(u.searchParams.get('market'),'spot');
  assert.equal(u.searchParams.get('symbol'),'BTCUSDT');
  const before=u.searchParams.has('before')?Number(u.searchParams.get('before')):null;
  const limit=Number(u.searchParams.get('limit'));
  assert.ok(limit>=1&&limit<=300);
  seen.push({before,limit});
  const range=before===null?all:all.filter(b=>b.time<before);
  const bars=range.slice(-limit);
  return {ok:true,json:async()=>({
    schema:'QSYN-PUBLIC-CRYPTO-BARS/1',source:'exchange_public',
    exchange:'BINANCE',market:'spot',symbol:'BTCUSDT',interval:'1m',
    trading_enabled:false,bars,
    pagination:{before,next_before:bars[0]?.time??null,has_more:bars.length===limit},
  })};
};
try{
  const req={exchange:'BINANCE:spot',symbol:'BTCUSDT',interval:'1m',
    from:now-500*60,to:now+20,signal:new AbortController().signal};
  const feed=new QsynCryptoFeed();
  assert.equal(INITIAL_BACKFILL_BARS,1600);
  assert.equal(MAX_AUTO_BACKFILL_BARS,15016);
  const normal=await feed.getBars(req);
  assert.equal(normal.length,1600);
  assert.ok(seen.length>1);
  assert.ok(normal.every((b,i)=>i===0||b.time===normal[i-1].time+60));
  const first=normal[0].time;
  const older=await feed.getBarsPage({...req,before:first,countBack:300});
  assert.equal(older.bars.length,300);
  assert.equal(older.bars.at(-1).time,first-60);
  assert.equal(older.nextBefore,older.bars[0].time);
  assert.equal(older.hasMore,true);
  assert.equal(feed.setHistoryTarget(req.exchange,req.symbol,req.interval,999999),true);
  assert.equal(feed.setHistoryTarget(req.exchange,req.symbol,req.interval,999999),false);
  seen.length=0;
  const maximum=await feed.getBars(req);
  assert.equal(maximum.length,MAX_AUTO_BACKFILL_BARS);
  assert.equal(maximum.at(-1).time,now);
  assert.ok(seen.length>=50&&seen.length<=54);
  assert.equal(new Set(maximum.map(x=>x.time)).size,maximum.length);
  // Historical cursor never triggers provider calls for unrelated instruments.
  assert.deepEqual(await feed.getBars({...req,symbol:'../../secrets'}),[]);
  // Live refresh must fetch TWO candles, not repeat a multi-page backfill.
  seen.length=0;
  const unsubscribe=feed.subscribeBars(req,()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  unsubscribe();
  assert.deepEqual(seen.map(x=>x.limit),[2]);
  feed.destroy();
  const ended=await feed.getBars(req);
  assert.deepEqual(ended,[]);

  const settings={setupTf:'15',samples:1000};
  const studies=[{indicatorId:WICK_SCIENCE_ID,settings:()=>settings}];
  assert.equal(wickRequiredBars(studies,'1m'),MAX_AUTO_BACKFILL_BARS);
  assert.equal(wickRequiredBars([{indicatorId:WICK_SCIENCE_ID,
    settings:()=>({setupTf:'5',samples:100})}],'1m'),516);
  assert.equal(wickRequiredBars(studies,'15m'),0);
  // Integration contract: for an unchanged instrument OpenAlgo's
  // widget.reload() only calls controller.refresh() (tail repair).
  // Wick's maximum must invoke a FULL native controller.load() with a wide
  // historical window, not a 300-candle refresh.
  const callbacks=new Map(),subscribers=new Set(),loads=[];
  let status='loading', retained=Array.from({length:1600},()=>({time:now})),refreshes=0;
  const request={exchange:'BINANCE:spot',symbol:'BTCUSDT',interval:'1m',
    from:now-1600*60,to:now+60};
  const controller={
    getState:()=>({status,request,bars:retained}),
    bars:()=>retained,
    subscribe:callback=>{subscribers.add(callback);return ()=>subscribers.delete(callback);},
    load:loadRequest=>{
      loads.push(loadRequest);
      status='loading';
      for(const callback of [...subscribers])callback();
      return Promise.resolve([]);
    },
    refresh:()=>{refreshes++;return Promise.resolve([])},
  };
  const settingsLive={setupTf:'15',samples:1000};
  const studiesLive=[{indicatorId:WICK_SCIENCE_ID,settings:()=>settingsLive}];
  const widget={
    isDestroyed:false,chart:{
      indicators:()=>studiesLive,
      on:(name,handler)=>{callbacks.set(name,handler);
        return ()=>callbacks.delete(name);},
    },
    dataController:controller,
    interval:()=> '1m',exchange:()=> 'BINANCE:spot',symbol:()=> 'BTCUSDT',
    reload:()=>{refreshes++;return Promise.resolve();},
  };
  const requested=[];
  const stub={setHistoryTarget:(exchange,symbol,interval,bars)=>{
    requested.push({exchange,symbol,interval,bars});return true;
  }};
  const stop=observeWickScienceBackfill(widget,stub);
  assert.equal(loads.length,0,'must not abort the initial native load');
  status='ready';
  for(const callback of [...subscribers])callback();
  assert.equal(loads.length,1);
  assert.equal(refreshes,0,'native tail refresh cannot supply older history');
  assert.equal(requested.length,1);
  assert.equal(requested[0].bars,MAX_AUTO_BACKFILL_BARS);
  assert.equal(loads[0].countBack,MAX_AUTO_BACKFILL_BARS);
  assert.equal(loads[0].noCache,false);
  assert.equal(loads[0].exchange,'BINANCE:spot');
  assert.equal(loads[0].interval,'1m');
  assert.ok(loads[0].from<=now-(MAX_AUTO_BACKFILL_BARS+2)*60);
  assert.ok(loads[0].to>=now);
  assert.equal(loads[0].timeoutMs,undefined);
  callbacks.get('objects:change')();
  assert.equal(loads.length,1,'one attempt per instrument/settings target');
  status='ready';
  retained=Array.from({length:MAX_AUTO_BACKFILL_BARS},()=>({time:now}));
  for(const callback of [...subscribers])callback();
  assert.equal(loads.length,1,'do not retry a completed full load');

  // Existing default 5m/100-sample study needs <=1600 candles. No full
  // network reread should occur when its history is already in the chart.
  settingsLive.setupTf='5';settingsLive.samples=100;
  retained=Array.from({length:1600},()=>({time:now}));
  callbacks.get('objects:change')();
  assert.equal(loads.length,1);
  stop();
  assert.equal(callbacks.size,0);
  assert.equal(subscribers.size,0);
  widget.isDestroyed=true;
  console.log('QSYN provider historical paging, auto max, live tail and indicator demand: PASS');
}finally{
  globalThis.fetch=original;
}

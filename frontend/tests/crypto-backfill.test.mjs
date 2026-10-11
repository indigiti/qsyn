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
  const callbacks=new Map();
  let reloads=0,requests=0;
  const widget={
    isDestroyed:false,chart:{
      indicators:()=>studies,
      on:(name,handler)=>{callbacks.set(name,handler);
        return ()=>callbacks.delete(name);},
    },
    interval:()=> '1m',exchange:()=> 'BINANCE:spot',symbol:()=> 'BTCUSDT',
    reload:()=>{reloads++;return Promise.resolve();},
  };
  const stub={setHistoryTarget:()=>{requests++;return requests===1;}};
  const stop=observeWickScienceBackfill(widget,stub);
  await Promise.resolve();await Promise.resolve();
  assert.equal(reloads,1);
  callbacks.get('objects:change')();
  await Promise.resolve();
  assert.equal(reloads,1);
  stop();
  assert.equal(callbacks.size,0);
  console.log('QSYN provider historical paging, auto max, live tail and indicator demand: PASS');
}finally{
  globalThis.fetch=original;
}

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyPublicBackfill} from './verify-public-backfill.mjs';

const now=Math.floor(Date.now()/60000)*60;
const all=Array.from({length:15500},(_,i)=>({
  time:now-(15499-i)*60,open:100,high:104,low:98,close:102,volume:1,
}));
function mock({gap=false,badCursor=false,stale=false}={}){
  const calls=[];
  const fetchFn=async url=>{
    const p=new URL(url),before=p.searchParams.has('before')?Number(p.searchParams.get('before')):null;
    const limit=Number(p.searchParams.get('limit'));
    calls.push({before,limit});
    const bars=(before===null?all:all.filter(x=>x.time<before)).slice(-limit).map(x=>({...x}));
    if(gap&&calls.length===2&&bars.length>50)bars.splice(50,1);
    if(stale&&calls.length===1)bars.forEach(b=>b.time-=86400);
    return {ok:true,status:200,json:async()=>({
      schema:'QSYN-PUBLIC-CRYPTO-BARS/1',source:'exchange_public',exchange:'BINANCE',
      market:'spot',symbol:'BTCUSDT',interval:'1m',trading_enabled:false,
      bars,pagination:{before,next_before:badCursor?42:bars[0]?.time??null,has_more:bars.length===limit}
    })};
  };
  return {calls,fetchFn};
}
test('six pages for 1600 contiguous candles',async()=>{
  const m=mock();const result=await verifyPublicBackfill({base:'http://localhost/qsyn',fetchFn:m.fetchFn,bars:1600});
  assert.equal(result.verified_bars,1600);assert.equal(result.page_count,6);
  assert.deepEqual(m.calls.map(x=>x.limit),[300,300,300,300,300,100]);
  assert.equal(m.calls[0].before,null);
  assert.ok(m.calls.slice(1).every((x,i)=>x.before<m.calls[i].before||i===0));
});
test('maximum Wick setup loads 15016 candles in 51 pages',async()=>{
  const m=mock();const result=await verifyPublicBackfill({base:'http://localhost/qsyn',fetchFn:m.fetchFn,bars:15016});
  assert.equal(result.verified_bars,15016);assert.equal(result.page_count,51);
  assert.equal(m.calls.at(-1).limit,16);
});
for(const [title,flag,code] of [
  ['rejects missing minute','gap','GAP_OR_DUPLICATE'],
  ['rejects wrong cursor','badCursor','INVALID_CURSOR'],
  ['rejects stale candles','stale','STALE_LATEST'],
])test(title,async()=>{
  const m=mock({[flag]:true});
  await assert.rejects(verifyPublicBackfill({base:'http://localhost/qsyn',fetchFn:m.fetchFn,bars:1600}),x=>x.code===code);
});
test('rejects invalid target and unsafe URLs',async()=>{
  await assert.rejects(verifyPublicBackfill({bars:20000}),e=>e.code==='INVALID_TARGET');
  await assert.rejects(verifyPublicBackfill({base:'http://example.com/qsyn'}),e=>e.code==='INVALID_TARGET');
});

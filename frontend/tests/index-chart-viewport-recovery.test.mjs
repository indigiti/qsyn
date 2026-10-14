import assert from 'node:assert/strict';
import {isIndexViewportEmpty,observeIndexChartViewport}
  from '../src/index-chart-viewport-recovery.js';

assert(isIndexViewportEmpty({from:500,to:650},375));
assert(isIndexViewportEmpty({from:-500,to:-2},375));
assert(!isIndexViewportEmpty({from:300,to:500},375),
  'a partial overlap must preserve the user view');
assert(!isIndexViewportEmpty({from:0,to:100},375));
assert(!isIndexViewportEmpty({from:NaN,to:100},375));
assert(!isIndexViewportEmpty({from:500,to:700},0));

let selection={exchange:'NSE_INDEX:index',symbol:'NIFTY',interval:'1m'};
const bars=Array.from({length:375},(_,i)=>({
  time:i*60+1700000000,open:1,high:2,low:1,close:2,volume:0
}));
let state={request:{...selection},status:'loading',reason:'load',bars:[]};
let listener=null,offCalls=0,reset=0,range={from:500,to:600};
const handlers=new Map();
const root={
  addEventListener:(event,handler)=>handlers.set(event,handler),
  removeEventListener:(event,handler)=>{
    assert.equal(handlers.get(event),handler);handlers.delete(event);
  }
};
const controller={
  subscribe:(fn)=>{listener=fn;return ()=>{offCalls++;listener=null;};},
  getState:()=>state
};
const chart={
  getVisibleLogicalRange:()=>range,
  primaryBars:()=>bars,
  resetScale:()=>{reset++;range={from:240,to:360};}
};
const widget={
  dataController:controller,chart,root,isDestroyed:false,
  exchange:()=>selection.exchange,symbol:()=>selection.symbol,
  interval:()=>selection.interval
};
const stop=observeIndexChartViewport(widget);
async function publish(request=selection,reason='load'){
  state={request:{...request},status:'ready',reason,bars};
  listener?.(state);
  await Promise.resolve();
}
await publish();
assert.equal(reset,1,'fully offscreen initial index chart recovers once');
await publish(selection,'refresh');
assert.equal(reset,1,'normal visible viewport must not be reset');
range={from:320,to:500};
await publish();
assert.equal(reset,1,'partially visible view is preserved');
handlers.get('wheel')();
range={from:600,to:800};
await publish(selection,'refresh');
assert.equal(reset,1,'a deliberate user gesture is never overridden');
// A newly selected index has its own first-data viewport recovery.
selection={exchange:'BSE_INDEX:index',symbol:'SENSEX',interval:'1m'};
await publish();
assert.equal(reset,2);
selection={exchange:'BINANCE:spot',symbol:'BTCUSDT',interval:'1m'};
range={from:600,to:800};
await publish();
assert.equal(reset,2,'crypto charts remain unchanged');
stop();
assert.equal(offCalls,1);
assert.equal(handlers.size,0);
assert.equal(listener,null);
console.log('PASS: index viewport only resets on entirely offscreen initial/chart refresh data');

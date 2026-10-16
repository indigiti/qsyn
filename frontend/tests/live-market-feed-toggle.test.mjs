import assert from 'node:assert/strict';
import {LIVE_MARKET_FEED_KEY,liveMarketFeedEnabled,setLiveMarketFeedEnabled,
  subscribeLiveMarketFeed,observeLiveMarketFeed} from '../src/live-market-feed-toggle.js';

const values=new Map(),storage={
  getItem:key=>values.has(key)?values.get(key):null,
  setItem:(key,value)=>{values.set(key,value);},
};
const target=new EventTarget();
const env={storage,target};
assert.equal(liveMarketFeedEnabled(env),true,'unset switch defaults to on');
let starts=0,stops=0;
const unsubscribe=subscribeLiveMarketFeed(()=>{
  starts++;
  let stopped=false;
  return ()=>{assert.equal(stopped,false,'subscription cleanup must run once');
    stopped=true;stops++;};
},env);
assert.deepEqual([starts,stops],[1,0]);
assert.equal(setLiveMarketFeedEnabled(false,env),false);
assert.equal(values.get(LIVE_MARKET_FEED_KEY),'0');
assert.deepEqual([starts,stops],[1,1],'off closes existing socket or timer');
setLiveMarketFeedEnabled(false,env);
assert.deepEqual([starts,stops],[1,1],'repeated off does not double cleanup');
setLiveMarketFeedEnabled(true,env);
assert.deepEqual([starts,stops],[2,1],'on creates one fresh subscription');
setLiveMarketFeedEnabled(true,env);
assert.deepEqual([starts,stops],[2,1]);
unsubscribe();
assert.deepEqual([starts,stops],[2,2],'destroy closes the active subscription');
setLiveMarketFeedEnabled(false,env);
assert.deepEqual([starts,stops],[2,2],'destroy unsubscribes toggle observer');

// Disabling before chart creation must not create a polling timer or WSS.
let deferredStarts=0,deferredStops=0;
const paused=subscribeLiveMarketFeed(()=>{
  deferredStarts++;return ()=>{deferredStops++;};
},env);
assert.equal(deferredStarts,0);
setLiveMarketFeedEnabled(true,env);
assert.equal(deferredStarts,1);
paused();
assert.equal(deferredStops,1);

// Cross-tab browser storage events are the only notifications sent to a
// different tab. The local tab must additionally receive our custom event.
const changed=[];
const off=observeLiveMarketFeed(v=>changed.push(v),env);
values.set(LIVE_MARKET_FEED_KEY,'0');
const event=new Event('storage');
Object.defineProperties(event,{
  key:{value:LIVE_MARKET_FEED_KEY},
  newValue:{value:'0'}
});
target.dispatchEvent(event);
assert.deepEqual(changed,[false]);
off();

// Fallback to in-memory control when browser storage is denied.
const blocked={getItem:()=>{throw Error('disabled')},
  setItem:()=>{throw Error('disabled')}};
const noStorage={storage:blocked,target:new EventTarget()};
setLiveMarketFeedEnabled(false,noStorage);
assert.equal(liveMarketFeedEnabled(noStorage),false);
setLiveMarketFeedEnabled(true,env);
console.log('PASS: browser market-feed switch pauses, resumes, persists and cleans up');

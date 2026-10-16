/**
 * Owner-browser preference for live CHART subscriptions only. This is not
 * a Rust worker or broker control: historical reads and OMS settings remain
 * unchanged, and enabling never grants private-market authorization.
 */
export const LIVE_MARKET_FEED_KEY='qsyn.live-chart-feed.v1';
const LIVE_MARKET_FEED_EVENT='qsyn:live-chart-feed-changed';
let fallbackEnabled=true;

function browserTarget(){
  return typeof window==='undefined'?null:window;
}
function browserStorage(){
  try{return browserTarget()?.localStorage||null;}catch{return null;}
}
export function liveMarketFeedEnabled({storage=browserStorage()}={}){
  try{
    const stored=storage?.getItem(LIVE_MARKET_FEED_KEY);
    if(stored==='0')return false;
    if(stored==='1')return true;
  }catch{/* Private storage may be blocked; preserve in-memory preference. */}
  return fallbackEnabled;
}
export function setLiveMarketFeedEnabled(enabled,{storage=browserStorage(),target=browserTarget()}={}){
  fallbackEnabled=enabled===true;
  try{storage?.setItem(LIVE_MARKET_FEED_KEY,fallbackEnabled?'1':'0');}catch{}
  // Storage events are not sent to the same tab; notify active chart feeds.
  target?.dispatchEvent?.(new Event(LIVE_MARKET_FEED_EVENT));
  return fallbackEnabled;
}
export function observeLiveMarketFeed(listener,{storage=browserStorage(),target=browserTarget()}={}){
  if(!target?.addEventListener)return ()=>{};
  const change=()=>listener(liveMarketFeedEnabled({storage}));
  const storageChange=event=>{
    if(event?.key!==LIVE_MARKET_FEED_KEY&&event?.key!==null)return;
    // A different tab can update the stored preference.
    if(event?.newValue==='1'||event?.newValue==='0')
      fallbackEnabled=event.newValue==='1';
    change();
  };
  target.addEventListener(LIVE_MARKET_FEED_EVENT,change);
  target.addEventListener('storage',storageChange);
  return ()=>{
    target.removeEventListener(LIVE_MARKET_FEED_EVENT,change);
    target.removeEventListener('storage',storageChange);
  };
}
/** Pause actually closes the subscription/timer, not merely its UI updates. */
export function subscribeLiveMarketFeed(start,options={}){
  let active=false,stopped=false,stopActive=()=>{};
  const sync=enabled=>{
    if(stopped||enabled===active)return;
    if(!enabled){
      active=false;
      const stop=stopActive;
      stopActive=()=>{};
      stop();
      return;
    }
    active=true;
    try{
      const stop=start();
      stopActive=typeof stop==='function'?stop:()=>{};
    }catch(error){
      active=false;
      throw error;
    }
  };
  const remove=observeLiveMarketFeed(sync,options);
  try{sync(liveMarketFeedEnabled(options));}
  catch(error){remove();throw error;}
  return ()=>{
    stopped=true;
    remove();
    if(active){active=false;stopActive();}
  };
}

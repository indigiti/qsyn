import React,{useEffect,useState} from 'react';
import {liveMarketFeedEnabled,observeLiveMarketFeed,setLiveMarketFeedEnabled} from './live-market-feed-toggle.js';
import './live-feed-switch.css';

/**
 * Single browser preference shared across dashboard, Markets and header.
 * This controls live subscriptions only, not the Rust worker, provider
 * authorization, historical OHLC or trading risk gates.
 */
export function useLiveFeedPreference(){
  const [enabled,setEnabled]=useState(()=>liveMarketFeedEnabled());
  useEffect(()=>observeLiveMarketFeed(setEnabled),[]);
  return enabled;
}
export function LiveFeedSwitch({compact=false,ariaLabel='Live market data feed'}){
  const enabled=useLiveFeedPreference();
  return <div className={'qsyn-feed-control'+(compact?' is-compact':'')}>
    <div className="qsyn-feed-control-copy">
      <strong>Live feed</strong>
      {!compact&&<small>{enabled?'Updates enabled · source separately verified':'Paused in this browser'}</small>}
    </div>
    <button type="button" role="switch" aria-label={ariaLabel} aria-checked={enabled}
      title={enabled?'Pause live chart subscriptions':'Resume live chart subscriptions'}
      className={'qsyn-feed-pill'+(enabled?' is-on':' is-off')}
      onClick={()=>setLiveMarketFeedEnabled(!enabled)}>
      <span aria-hidden="true">OFF</span><span aria-hidden="true">ON</span>
      <span aria-hidden="true" className="qsyn-feed-pill-knob"/>
    </button>
  </div>;
}

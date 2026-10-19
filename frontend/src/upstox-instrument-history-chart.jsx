import React,{useEffect,useRef,useState} from 'react';
import {createWidget} from 'openalgo-charts/widget';
import {PrivateUpstoxInstrumentHistoryFeed} from './upstox-instrument-history-feed.js';
import {todayIst} from './personal-index-feed.js';

/** Historical-only chart; streaming is not implied by instrument discovery. */
export function UpstoxInstrumentHistoryChart({instrument}){
  const [date,setDate]=useState(todayIst);
  const [csrf,setCsrf]=useState('');
  const [opened,setOpened]=useState(false);
  const [status,setStatus]=useState('Checking Upstox account authorization…');
  const [liveStatus,setLiveStatus]=useState('Live feed is on-demand when Today is selected.');
  const host=useRef(null);
  useEffect(()=>{
    const ctl=new AbortController();setOpened(false);setCsrf('');
    void fetch('/qsyn/api/v1/admin/upstox/index-history-proof',{
      credentials:'same-origin',cache:'no-store',signal:ctl.signal,
      headers:{Accept:'application/json'}
    }).then(async response=>{
      if(!response.ok)throw Error('UPSTOX_ACCOUNT_PROOF_UNAVAILABLE');
      const proof=await response.json();
      if(proof.schema!=='QSYN-INDEX-HISTORICAL-PROOF/1'||
        proof.token_present!==true||typeof proof.csrf!=='string')
        throw Error('UPSTOX_ANALYTICS_TOKEN_NOT_READY');
      if(!ctl.signal.aborted){setCsrf(proof.csrf);setStatus('Authorized. Choose a trading date.');}
    }).catch(error=>{if(!ctl.signal.aborted)setStatus(error?.message||'UPSTOX_PROOF_UNAVAILABLE');});
    return()=>ctl.abort();
  },[instrument.instrument_key]);
  useEffect(()=>{
    if(!opened||!csrf||!host.current)return;
    const feed=new PrivateUpstoxInstrumentHistoryFeed({
      instrument,day:date,csrf,onStatus:s=>{
        if(s.startsWith('UPSTOX_LIVE')||s.startsWith('Rust Upstox')||
          s.startsWith('Provider Upstox'))setLiveStatus(s);
        else setStatus(s);
      }
    });
    let widget;
    try{
      widget=createWidget(host.current,{
        feed,exchange:'UPSTOX_SCOPED',symbol:instrument.instrument_key,
        interval:'1m',intervals:['1m'],theme:'light',persist:false,
        panels:true,toolbar:true,branding:false,
        navigation:{defaultVisibleBars:120,mousePan:'horizontal'}
      });
      widget.ready.catch(()=>setStatus('Upstox historical chart initialization failed'));
    }catch{setStatus('Upstox historical chart initialization failed');}
    return()=>{feed.destroy();try{widget?.destroy();}catch{}};
  },[opened,csrf,instrument,date]);
  return <section className="qs-upstox-history" aria-label="Upstox historical instrument chart">
    <label>Trading date (IST)<input type="date" min="2022-01-01" max={todayIst()}
      value={date} onChange={e=>{setDate(e.target.value);setOpened(false);}}/></label>
    <button type="button" className="terminal-action"
      disabled={!csrf||!date||opened||!instrument.selection_scope}
      onClick={()=>{setOpened(true);setStatus('Requesting actual Upstox V3 history…');}}>
      Open historical chart</button>
    {opened&&<div className="qt-private-history-host" ref={host}/>}
    <p role="status">{status}</p>
    <p role="status">{liveStatus}</p>
    <p>Volume and open interest reflect provider fields where available.
      Live 1-minute OHLCV uses Upstox full-mode provider candles when authenticated
      through one bounded Rust socket. Availability still requires Upstox access.
      The original seven index feeds remain unchanged.</p>
  </section>;
}

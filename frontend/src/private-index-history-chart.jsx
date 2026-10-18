import React,{useEffect,useRef,useState} from 'react';
import {createWidget} from 'openalgo-charts/widget';
import {PrivateIndexHistoryFeed,todayIst} from './personal-index-feed.js';


/**
 * Single Rust transport: 1m Upstox V3 history and tick-by-tick V3 WSS.
 * Same existing 1-year Analytics Token, never exposed to the browser.
 * No OAuth, approval plan, REST poll, synthetic provider or new Rust ELF.
 */
export function PrivateIndexHistoryChart({symbol}){
  const chartRef=useRef(null);
  const [auth,setAuth]=useState(null);
  const [date,setDate]=useState('');
  const [opened,setOpened]=useState(false);
  const [status,setStatus]=useState('Checking private account access…');
  const [liveStatus,setLiveStatus]=useState('Rust V3 streaming connects on Today’s chart.');
  useEffect(()=>{
    const c=new AbortController();
    setOpened(false);setAuth(null);
    void fetch('/qsyn/api/v1/admin/upstox/index-history-proof',{
      credentials:'same-origin',cache:'no-store',signal:c.signal,
      headers:{Accept:'application/json'}
    }).then(async r=>{
      // Keep access failures and absent tokens distinct from chart/market issues.
      // The response may be an HTML edge denial; never display its body.
      if(r.status===401)throw Error('QSYN_ADMIN_LOGIN_REQUIRED');
      if(r.status===403)throw Error('UPSTOX_CHART_ACCESS_DENIED');
      const data=await r.json().catch(()=>null);
      if(!r.ok||data?.schema!=='QSYN-INDEX-HISTORICAL-PROOF/1')
        throw Error('UPSTOX_HISTORY_PROOF_UNAVAILABLE');
      if(data.token_present!==true)throw Error('UPSTOX_ANALYTICS_TOKEN_NOT_READY');
      if(typeof data.csrf!=='string')throw Error('QSYN_CHART_SESSION_NOT_READY');
      if(!c.signal.aborted){setAuth(data.csrf);setDate(data.suggested_day_ist);
        setStatus('Upstox token available · Rust historical-data check on chart open.');}
    }).catch(error=>{
      if(c.signal.aborted)return;
      const code=['QSYN_ADMIN_LOGIN_REQUIRED','UPSTOX_CHART_ACCESS_DENIED',
        'UPSTOX_HISTORY_PROOF_UNAVAILABLE','UPSTOX_ANALYTICS_TOKEN_NOT_READY',
        'QSYN_CHART_SESSION_NOT_READY'].includes(error?.message)
        ? error.message : 'UPSTOX_HISTORY_PROOF_UNAVAILABLE';
      setStatus('Upstox chart unavailable · '+code+'. Check Data Providers → Upstox Token.');
    });
    return()=>c.abort();
  },[symbol]);
  useEffect(()=>{
    if(!opened||!auth||!chartRef.current)return;
    let widget;
    const feed=new PrivateIndexHistoryFeed({symbol,day:date,csrf:auth,
      onStatus:setStatus,onLive:setLiveStatus});
    setLiveStatus(date===todayIst()
      ? 'Connecting Rust Upstox V3 tick-by-tick WebSocket'
      : 'Past-date historical chart · choose Today for current quotes');
    try{
      widget=createWidget(chartRef.current,{
        feed,exchange:'UPSTOX_PERSONAL',symbol,interval:'1m',intervals:['1s','1m'],
        theme:'light',persist:false,panels:true,toolbar:true,branding:false,
        navigation:{defaultVisibleBars:120,mousePan:'horizontal'},
      });
      widget.ready.catch(()=>setStatus('Private chart widget failed to initialize.'));
    }catch{setStatus('Private chart widget failed to initialize.');}
    return()=>{
      feed.destroy();
      try{widget?.destroy();}catch{}
    };
  },[opened,auth,date,symbol]);
  function changeDate(next){setDate(next);setOpened(false);}
  return <section className="terminal-surface qt-private-history-chart">
    <div className="terminal-card-head">
      <h3>{symbol} · Upstox personal chart</h3>
      <span className="terminal-chip">PRIVATE · ANALYTICS TOKEN</span>
    </div>
    <div className="qt-index-proof-actions">
      <label>Completed trading date (IST)
        <input type="date" value={date} onChange={e=>changeDate(e.target.value)}/></label>
      <button type="button" className="terminal-action terminal-secondary-action"
        onClick={()=>changeDate(todayIst())}>Today</button>
    </div>
    <button type="button" className="terminal-action" disabled={!auth||!date||opened}
      onClick={()=>{setOpened(true);setStatus('Loading actual Upstox historical candles…');}}>
      Open {symbol} historical chart
    </button>
    {opened&&<div className="terminal-chart-host qt-private-history-host"
      ref={chartRef} aria-label={symbol+' private historical candlestick chart'}/>}
    <p role="status" className="terminal-footnote">{status}</p>
    <p role="status" className="terminal-footnote">{liveStatus}</p>
    <p className="terminal-footnote" aria-label="Upstox index volume availability">
      Volume: N/A for cash indices. A zero in the chart's internal OHLCV
      format is a compatibility placeholder, not actual traded volume.
    </p>
    <p className="terminal-footnote">One private Analytics Token · Rust Upstox V3
      tick-by-tick WebSocket · Rust historical 1-minute candles. No OAuth,
      operator plan, PHP quote polling or separate Rust executable.
      Market-closed periods are not labeled as live; trading stays disabled.</p>
  </section>;
}


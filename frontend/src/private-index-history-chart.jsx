import React,{useEffect,useRef,useState} from 'react';
import {createWidget} from 'openalgo-charts/widget';
import {AuthorizedIndexLiveBridge,verifyPrivateIndexLiveGrant} from './private-index-live-bridge.js';

/**
 * Historical 1m charts only. No WSS, live tick synthesis, token transport in
 * browser, persistent OHLC cache, public NSE/BSE API or simulated fallback.
 */
class PrivateIndexHistoryFeed {
  constructor({symbol,day,csrf,onStatus,liveBridge=null}){
    this.symbol=symbol;this.day=day;this.csrf=csrf;this.onStatus=onStatus;
    this.liveBridge=liveBridge;
    this.closed=false;this.controllers=new Set();
  }
  async getBars(req){
    if(this.closed||req.symbol!==this.symbol||
      req.exchange!=='UPSTOX_PERSONAL'||req.interval!=='1m')return [];
    const ctl=new AbortController();
    const abort=()=>ctl.abort();
    req.signal?.addEventListener('abort',abort,{once:true});
    this.controllers.add(ctl);
    try{
      const response=await fetch('/qsyn/api/v1/admin/upstox/private-index-chart',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        signal:ctl.signal,headers:{
          'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':this.csrf
        },body:JSON.stringify({confirmed:true,private_view_acknowledged:true,
          symbol:this.symbol,day:this.day})
      });
      const json=await response.json();
      if(!response.ok)throw Error(json.error||'PRIVATE_INDEX_HISTORY_UNAVAILABLE');
      if(json.schema!=='QSYN-PRIVATE-UPSTOX-HISTORY-CHART/1'||
        json.source!=='upstox_private_analytics_history'||
        json.account_scoped!==true||json.personal_private_view_only!==true||
        json.public_redistribution_allowed!==false||
        json.trading_enabled!==false||json.live_stream_verified!==false||
        json.symbol!==this.symbol||json.day_ist!==this.day||json.interval!=='1m'||
        json.exchange!==(this.symbol==='SENSEX'?'BSE_INDEX':'NSE_INDEX')||
        !Array.isArray(json.bars)||json.bars.length<1||json.bars.length>400)
        throw Error('PRIVATE_INDEX_HISTORY_INVALID');
      let previous=0;
      for(const bar of json.bars){
        if(!Number.isSafeInteger(bar?.time)||bar.time%60!==0||bar.time<=previous||
          !['open','high','low','close','volume'].every(k=>Number.isFinite(bar[k]))||
          bar.open<=0||bar.low<=0||bar.close<=0||bar.volume<0||
          bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))
          throw Error('PRIVATE_INDEX_CANDLE_INVALID');
        previous=bar.time;
      }
      if(!this.closed&&!ctl.signal.aborted){
        const clock=new Intl.DateTimeFormat('en-GB',{
          timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
        });
        const first=clock.format(new Date(json.bars[0].time*1000));
        const last=clock.format(new Date(json.bars[json.bars.length-1].time*1000));
        this.onStatus(json.bars.length+' Upstox 1-minute historical candles · '+
          this.day+' · '+first+'–'+last+' IST');
      }
      return this.closed||ctl.signal.aborted?[]:json.bars;
    }catch(e){
      if(this.closed||ctl.signal.aborted||e?.name==='AbortError')return [];
      this.onStatus(/^[A-Z0-9_]{3,90}$/i.test(e.message||'')
        ?e.message:'PRIVATE_INDEX_HISTORY_NOT_AVAILABLE');
      return [];
    }finally{
      this.controllers.delete(ctl);req.signal?.removeEventListener('abort',abort);
    }
  }
  // Uses only the separately grant-validated operator-private source; a stored
  // Analytics Token alone can never attach a streaming subscription.
  subscribeBars(req,onBar){
    return !this.closed&&this.liveBridge
      ? this.liveBridge.subscribeBars(req,onBar):()=>{};
  }
  destroy(){
    this.closed=true;
    for(const c of this.controllers)c.abort();
    this.controllers.clear();
    this.liveBridge?.destroy();
  }
}

export function PrivateIndexHistoryChart({symbol}){
  const chartRef=useRef(null);
  const [auth,setAuth]=useState(null);
  const [date,setDate]=useState('');
  const [ack,setAck]=useState(false);
  const [opened,setOpened]=useState(false);
  const [status,setStatus]=useState('Checking private account access…');
  const [liveGrant,setLiveGrant]=useState(null);
  const [liveStatus,setLiveStatus]=useState('Live index feed not verified.');
  useEffect(()=>{
    const c=new AbortController();
    setOpened(false);setAck(false);setAuth(null);
    void fetch('/qsyn/api/v1/admin/upstox/index-history-proof',{
      credentials:'same-origin',cache:'no-store',signal:c.signal,
      headers:{Accept:'application/json'}
    }).then(async r=>{
      const data=await r.json();
      if(!r.ok||data.schema!=='QSYN-INDEX-HISTORICAL-PROOF/1'||
        !data.token_present||typeof data.csrf!=='string')
        throw Error('PRIVATE_ACCOUNT_NOT_READY');
      if(!c.signal.aborted){setAuth(data.csrf);setDate(data.suggested_day_ist);
        setStatus('Ready for personal historical-data view. Live feed not enabled.');}
    }).catch(()=>{if(!c.signal.aborted)setStatus('Private Upstox account access unavailable.');});
    return()=>c.abort();
  },[symbol]);
  useEffect(()=>{
    if(!opened||!auth)return;
    const controller=new AbortController();
    setLiveGrant(null);
    setLiveStatus('Checking separately authorized private live index grant…');
    void verifyPrivateIndexLiveGrant(symbol,{signal:controller.signal})
      .then(grant=>{
        if(controller.signal.aborted)return;
        setLiveGrant(grant);
        setLiveStatus(grant
          ? 'Approved viewer grant available; exchange ticks not yet verified.'
          : 'Historical only · independent live index grant unavailable.');
      });
    return()=>controller.abort();
  },[opened,auth,symbol]);
  useEffect(()=>{
    if(!opened||!auth||!chartRef.current)return;
    let widget;
    const liveBridge=liveGrant ? new AuthorizedIndexLiveBridge({
      symbol,account:liveGrant.account,
      onStatus:message=>{
        // WSS authentication alone is not exchange-tick evidence.
        if(message.includes('chart connected'))
          setLiveStatus('Private WSS authenticated; awaiting real exchange ticks.');
        else setLiveStatus(message);
      },
      onTick:timeMs=>{
        const time=new Intl.DateTimeFormat('en-GB',{
          timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',
          second:'2-digit',hourCycle:'h23'
        }).format(new Date(timeMs));
        setLiveStatus('Live exchange tick verified · '+time+' IST');
      },
    }) : null;
    const feed=new PrivateIndexHistoryFeed({symbol,day:date,csrf:auth,
      onStatus:setStatus,liveBridge});
    try{
      widget=createWidget(chartRef.current,{
        feed,exchange:'UPSTOX_PERSONAL',symbol,interval:'1m',intervals:['1m'],
        theme:'light',persist:false,panels:true,toolbar:true,branding:false,
        navigation:{defaultVisibleBars:120,mousePan:'horizontal'},
      });
      widget.ready.catch(()=>setStatus('Private chart widget failed to initialize.'));
    }catch{setStatus('Private chart widget failed to initialize.');}
    return()=>{
      feed.destroy();
      try{widget?.destroy();}catch{}
    };
  },[opened,auth,date,symbol,liveGrant]);
  function changeDate(next){setDate(next);setOpened(false);}
  return <section className="terminal-surface qt-private-history-chart">
    <div className="terminal-card-head">
      <h3>{symbol} · Upstox historical candles</h3>
      <span className="terminal-chip">PRIVATE · HISTORICAL</span>
    </div>
    <div className="qt-index-proof-actions">
      <label>Completed trading date (IST)
        <input type="date" value={date} onChange={e=>changeDate(e.target.value)}/></label>
    </div>
    <label className="qt-prepare-confirm"><input type="checkbox" checked={ack}
      onChange={e=>setAck(e.target.checked)}/>
      Personal account view only. I will not publicly redistribute NSE/BSE
      market data. This does not certify exchange entitlements.</label>
    <button type="button" className="terminal-action" disabled={!auth||!ack||!date||opened}
      onClick={()=>{setOpened(true);setStatus('Loading actual Upstox historical candles…');}}>
      Open {symbol} historical chart
    </button>
    {opened&&<div className="terminal-chart-host qt-private-history-host"
      ref={chartRef} aria-label={symbol+' private historical candlestick chart'}/>}
    <p role="status" className="terminal-footnote">{status}</p>
    <p role="status" className="terminal-footnote">{liveStatus}</p>
    <p className="terminal-footnote">Account-only historical data. Live exchange
      ticks join this chart only after a separately approved private grant and
      authenticated Rust WSS; no public homepage publishing. Prices and broker
      credentials are never stored in browser storage.</p>
  </section>;
}

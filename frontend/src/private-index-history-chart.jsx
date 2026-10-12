import React,{useEffect,useRef,useState} from 'react';
import {createWidget} from 'openalgo-charts/widget';


/**
 * Single Rust transport: 1m Upstox V3 history and tick-by-tick V3 WSS.
 * Same existing 1-year Analytics Token, never exposed to the browser.
 * No OAuth, approval plan, REST poll, synthetic provider or new Rust ELF.
 */
class PrivateIndexHistoryFeed {
  constructor({symbol,day,csrf,onStatus,onLive=()=>{}}){
    this.symbol=symbol;this.day=day;this.csrf=csrf;this.onStatus=onStatus;
    this.onLive=onLive;
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
      const response=await fetch('/qsyn/api/v1/admin/upstox/personal-index/history',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        signal:ctl.signal,headers:{
          'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':this.csrf
        },body:JSON.stringify({symbol:this.symbol,day:this.day})
      });
      const json=await response.json();
      if(!response.ok)throw Error(json.error||'PRIVATE_INDEX_HISTORY_UNAVAILABLE');
      if(json.schema!=='QSYN-UPSTOX-RUST-INDEX-HISTORY/1'||
        json.source!=='upstox_v3_rust_history'||
        json.public_redistribution_allowed!==false||
        json.trading_enabled!==false||
        json.symbol!==this.symbol||json.day_ist!==this.day||json.interval!=='1m'||
        !Array.isArray(json.bars)||json.bars.length>400)
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
  // One authenticated browser socket -> existing Rust service -> Upstox V3.
  // Tickets are issued by QSYN admin PHP; the one-year Analytics Token stays
  // in the private runtime and is never put in WS URLs or browser JS.
  subscribeBars(req,onBar){
    if(this.closed||req.symbol!==this.symbol||req.exchange!=='UPSTOX_PERSONAL'||
       req.interval!=='1m'||this.day!==todayIst())return ()=>{};
    const controller=new AbortController();
    let stopped=false,socket=null,lastTimestamp=0;
    this.controllers.add(controller);
    const connect=async()=>{
      try{
        const response=await fetch('/qsyn/api/v1/admin/upstox/personal-index/ticket',{
          method:'POST',credentials:'same-origin',cache:'no-store',
          signal:controller.signal,
          headers:{'Content-Type':'application/json','Accept':'application/json',
            'X-CSRF-Token':this.csrf},
          body:JSON.stringify({symbol:this.symbol})
        });
        const auth=await response.json();
        if(!response.ok)throw Error(auth.error||'RUST_PERSONAL_TICKET_UNAVAILABLE');
        if(auth.schema!=='QSYN-PERSONAL-INDEX-RUST-TICKET/1'||
           auth.symbol!==this.symbol||auth.trading_enabled!==false||
           auth.websocket_path!=='/qsyn/ws/personal-index'||
           typeof auth.ticket!=='string'||auth.ticket.length>512)
          throw Error('RUST_PERSONAL_TICKET_INVALID');
        if(stopped||controller.signal.aborted)return;
        const url=new URL(auth.websocket_path,window.location.origin);
        url.protocol=window.location.protocol==='https:'?'wss:':'ws:';
        socket=new WebSocket(url.href);
        socket.onopen=()=>{
          if(!stopped)socket.send(JSON.stringify({ticket:auth.ticket}));
          this.onLive('Rust WebSocket connected · awaiting Upstox V3 exchange ticks');
        };
        socket.onmessage=event=>{
          if(stopped||this.closed)return;
          let data;
          try{data=JSON.parse(event.data);}catch{return;}
          const bar=data?.bar;
          if(data?.schema!=='QSYN-RUST-PERSONAL-INDEX-TICK/1'||
             data?.source!=='upstox_v3_websocket'||data?.symbol!==this.symbol||
             data?.trading_enabled!==false||!Number.isSafeInteger(data.time_ms)||
             data.time_ms<=lastTimestamp||!Number.isFinite(data.price)||data.price<=0||
             !Number.isSafeInteger(bar?.time)||bar.time!==Math.floor(data.time_ms/60000)*60||
             !['open','high','low','close'].every(k=>Number.isFinite(bar[k]))||
             bar.open<=0||bar.high<Math.max(bar.open,bar.close)||
             bar.low>Math.min(bar.open,bar.close)||bar.low<=0)
            return;
          lastTimestamp=data.time_ms;
          onBar(bar);
          this.onLive('Rust Upstox V3 tick · '+
            new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',
              hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
              .format(new Date(data.time_ms))+' IST');
        };
        socket.onerror=()=>{
          if(!stopped)this.onLive('RUST_UPSTOX_WEBSOCKET_UNAVAILABLE');
        };
        socket.onclose=()=>{
          if(!stopped)this.onLive('Rust WebSocket disconnected · no live feed');
        };
      }catch(e){
        if(!stopped&&!controller.signal.aborted){
          this.onLive(/^[a-z0-9_]{3,90}$/i.test(e.message||'')
            ?e.message:'RUST_PERSONAL_DATA_UNAVAILABLE');
        }
      }
    };
    void connect();
    const stop=()=>{
      stopped=true;controller.abort();
      try{socket?.close(1000,'chart_closed');}catch{}
      this.controllers.delete(controller);
    };
    req.signal?.addEventListener('abort',stop,{once:true});
    return ()=>{req.signal?.removeEventListener('abort',stop);stop();};
  }
  destroy(){
    this.closed=true;
    for(const c of this.controllers)c.abort();
    this.controllers.clear();
  }
}

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
    if(!opened||!auth||!chartRef.current)return;
    let widget;
    const feed=new PrivateIndexHistoryFeed({symbol,day:date,csrf:auth,
      onStatus:setStatus,onLive:setLiveStatus});
    setLiveStatus(date===todayIst()
      ? 'Connecting Rust Upstox V3 tick-by-tick WebSocket'
      : 'Past-date historical chart · choose Today for current quotes');
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
    <p className="terminal-footnote">One private Analytics Token · Rust Upstox V3
      tick-by-tick WebSocket · Rust historical 1-minute candles. No OAuth,
      operator plan, PHP quote polling or separate Rust executable.
      Market-closed periods are not labeled as live; trading stays disabled.</p>
  </section>;
}

function todayIst(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=type=>parts.find(p=>p.type===type)?.value;
  return get('year')+'-'+get('month')+'-'+get('day');
}

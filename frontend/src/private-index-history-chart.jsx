import React,{useEffect,useRef,useState} from 'react';
import {createWidget} from 'openalgo-charts/widget';


/**
 * Personal chart: read-only Upstox historical candles plus actual 1m exchange
 * OHLC quotes from the same Analytics Token. No OAuth, plan, token in browser,
 * fabricated candles, new Rust process or public market-data route.
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
  // Upstox-sourced candle refresh only. The server obtains the 1m candle
  // from Upstox V3 OHLC (not from the browser clock or a synthetic LTP bar).
  subscribeBars(req,onBar){
    if(this.closed||req.symbol!==this.symbol||req.exchange!=='UPSTOX_PERSONAL'||
       req.interval!=='1m'||this.day!==todayIst())return ()=>{};
    let stopped=false,busy=false,watermark=0,lastClose=null;
    const controller=new AbortController();
    const poll=async()=>{
      if(stopped||this.closed||busy)return;
      busy=true;
      try{
        const response=await fetch('/qsyn/api/v1/admin/upstox/personal-index-ohlc',{
          method:'POST',credentials:'same-origin',cache:'no-store',
          signal:controller.signal,headers:{'Content-Type':'application/json',
            'Accept':'application/json','X-CSRF-Token':this.csrf},
          body:JSON.stringify({symbol:this.symbol})
        });
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'UPSTOX_QUOTE_UNAVAILABLE');
        if(data.schema!=='QSYN-UPSTOX-PERSONAL-OHLC/1'||data.symbol!==this.symbol||
           data.interval!=='1m'||data.personal_view_only!==true||
           data.trading_enabled!==false||data.public_redistribution_allowed!==false||
           !Array.isArray(data.bars)||data.bars.length>2)
          throw Error('UPSTOX_QUOTE_INVALID');
        let last=0;
        for(const bar of data.bars){
          if(!Number.isSafeInteger(bar?.time)||bar.time%60!==0||bar.time<=last||
             !['open','high','low','close','volume'].every(k=>Number.isFinite(bar[k]))||
             bar.open<=0||bar.low<=0||bar.close<=0||bar.volume<0||
             bar.high<Math.max(bar.open,bar.close)||
             bar.low>Math.min(bar.open,bar.close))
            throw Error('UPSTOX_QUOTE_CANDLE_INVALID');
          last=bar.time;
          if(bar.time>watermark||(bar.time===watermark&&bar.close!==lastClose)){
            if(!stopped&&!this.closed){
              onBar(bar);watermark=bar.time;lastClose=bar.close;
              this.onLive('Upstox 1m OHLC updated · '+
                new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',
                  hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
                  .format(new Date(bar.time*1000))+' IST');
            }
          }
        }
        if(data.bars.length===0&&!stopped)
          this.onLive('No fresh Upstox candle · market closed or quote delayed');
      }catch(e){
        if(!controller.signal.aborted&&!stopped&&!this.closed)
          this.onLive(/^[A-Z0-9_]{3,90}$/i.test(e.message||'')
            ?e.message:'UPSTOX_QUOTE_UNAVAILABLE');
      }finally{busy=false;}
    };
    void poll();
    const timer=setInterval(()=>void poll(),12000);
    const stop=()=>{stopped=true;clearInterval(timer);controller.abort();};
    req.signal?.addEventListener('abort',stop,{once:true});
    this.controllers.add(controller);
    return ()=>{req.signal?.removeEventListener('abort',stop);
      stop();this.controllers.delete(controller);};
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
  const [liveStatus,setLiveStatus]=useState('Live OHLC refresh available on today’s chart.');
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
      ? 'Checking Upstox current-day 1m OHLC · 12-second refresh'
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
    <p className="terminal-footnote">Personal Analytics Token only. Current-day
      candles update from Upstox V3 1-minute OHLC every 12 seconds; no OAuth,
      operator plan, separately approved private grant or Rust worker required.
      Market-closed data is never labeled live. This does not publish market
      data or permit trading.</p>
  </section>;
}

function todayIst(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=type=>parts.find(p=>p.type===type)?.value;
  return get('year')+'-'+get('month')+'-'+get('day');
}

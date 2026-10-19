import {subscribeLiveMarketFeed} from './live-market-feed-toggle.js';
import {todayIst} from './personal-index-feed.js';

/** Only accept actual provider I1 OHLCV, not reconstructed ticks. */
export function validScopedLive(data,key,previousTime=0,previousVolume=0){
  const bar=data?.bar;
  if(data?.schema!=='QSYN-RUST-UPSTOX-INSTRUMENT-LIVE/1'||
     data.source!=='upstox_v3_full_provider_ohlc'||
     data.instrument_key!==key||data.trading_enabled!==false||
     !Number.isSafeInteger(data.provider_time_ms)||data.provider_time_ms<=0||
     !Number.isSafeInteger(bar?.time)||bar.time%60!==0||bar.time<previousTime||
     !['open','high','low','close','volume'].every(k=>Number.isFinite(bar[k]))||
     bar.open<=0||bar.close<=0||bar.low<=0||bar.volume<0||
     bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||
     typeof data.volume_available!=='boolean'||
     (!data.volume_available&&bar.volume!==0)||
     (previousTime===bar.time&&bar.volume<previousVolume)||
     (data.open_interest!=null&&(!Number.isFinite(data.open_interest)||
         data.open_interest<0))||
     Math.abs(data.provider_time_ms-bar.time*1000)>120000)return false;
  return true;
}
/** Read-only Upstox history for server-signed instrument keys. No live socket. */
export class PrivateUpstoxInstrumentHistoryFeed {
  constructor({instrument,day,csrf,onStatus=()=>{}}){
    this.instrument=instrument;this.day=day;this.csrf=csrf;this.onStatus=onStatus;
    this.closed=false;this.controllers=new Set();this.inflight=null;
  }
  async getBars(req){
    if(this.closed||req.exchange!=='UPSTOX_SCOPED'||
       req.symbol!==this.instrument.instrument_key||req.interval!=='1m')return [];
    if(!this.inflight||req.noCache===true)
      this.inflight=this.requestBars(req).catch(error=>{this.inflight=null;throw error;});
    return this.inflight;
  }
  async requestBars(req){
    const controller=new AbortController(),abort=()=>controller.abort();
    req.signal?.addEventListener('abort',abort,{once:true});this.controllers.add(controller);
    try{
      const response=await fetch('/qsyn/api/v1/admin/upstox/instruments/history',{
        method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':this.csrf},
        body:JSON.stringify({scope:this.instrument.selection_scope,day:this.day})
      });
      if(response.status===401||response.status===403)throw Error('UPSTOX_INSTRUMENT_ACCESS_DENIED');
      const data=await response.json().catch(()=>null);
      if(!response.ok||!data)throw Error('UPSTOX_INSTRUMENT_HISTORY_UNAVAILABLE');
      if(data.schema!=='QSYN-UPSTOX-INSTRUMENT-HISTORY/1'||
        data.source!=='upstox_v3_private_instrument_history'||
        data.instrument_key!==this.instrument.instrument_key||data.day_ist!==this.day||
        data.interval!=='1m'||data.trading_enabled!==false||
        data.public_redistribution_allowed!==false||data.live_feed_verified!==false||
        !Array.isArray(data.bars)||data.bars.length>1800)
        throw Error('UPSTOX_INSTRUMENT_HISTORY_INVALID');
      let last=0;
      for(const bar of data.bars){
        if(!Number.isSafeInteger(bar?.time)||bar.time<=last||bar.time%60!==0||
          !['open','high','low','close','volume'].every(k=>Number.isFinite(bar[k]))||
          bar.open<=0||bar.low<=0||bar.close<=0||bar.volume<0||
          bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||
          typeof bar.volume_available!=='boolean'||(!bar.volume_available&&bar.volume!==0)||
          (bar.open_interest!=null&&(!Number.isSafeInteger(bar.open_interest)||bar.open_interest<0)))
          throw Error('UPSTOX_INSTRUMENT_CANDLE_INVALID');
        last=bar.time;
      }
      if(!this.closed&&!controller.signal.aborted)this.onStatus(data.bars.length
        ?data.bars.length+' provider-backed Upstox 1m candles · '+this.day
        :'No Upstox candles returned for '+this.day);
      return this.closed||controller.signal.aborted?[]:data.bars;
    }catch(e){
      if(!this.closed&&!controller.signal.aborted)this.onStatus(e?.message||'UPSTOX_HISTORY_UNAVAILABLE');
      if(req.strictHistory===true)throw e;
      return [];
    }finally{this.controllers.delete(controller);req.signal?.removeEventListener('abort',abort);}
  }
  getBarsPage(){return Promise.resolve({bars:[],hasMore:false});}
  subscribeBars(req,onBar){
    if(this.closed||this.day!==todayIst()||req.exchange!=='UPSTOX_SCOPED'||
      req.symbol!==this.instrument.instrument_key||req.interval!=='1m')return ()=>{};
    return subscribeLiveMarketFeed(()=>this._subscribeBarsActive(req,onBar));
  }
  _subscribeBarsActive(req,onBar){
    if(this.closed)return ()=>{};
    let stopped=false,socket=null,timer=null,retryDelay=2000;
    let lastTime=0,lastVolume=0;
    const controller=new AbortController();
    this.controllers.add(controller);
    const stop=()=>{
      stopped=true;controller.abort();
      if(timer!==null)clearTimeout(timer);
      try{socket?.close(1000,'chart_closed');}catch{}
      this.controllers.delete(controller);
    };
    const reconnect=()=>{
      if(stopped||this.closed||controller.signal.aborted)return;
      if(timer!==null)clearTimeout(timer);
      timer=setTimeout(()=>{timer=null;void connect();},retryDelay);
      retryDelay=Math.min(retryDelay*2,60000);
    };
    const connect=async()=>{
      if(stopped||this.closed||controller.signal.aborted)return;
      try{
        const response=await fetch('/qsyn/api/v1/admin/upstox/instruments/ticket',{
          method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
          headers:{'Content-Type':'application/json',Accept:'application/json',
            'X-CSRF-Token':this.csrf},
          body:JSON.stringify({scope:this.instrument.selection_scope})
        });
        if([401,403,409,422].includes(response.status)){
          this.onStatus('UPSTOX_LIVE_ACCESS_OR_SELECTION_EXPIRED');
          stop();return;
        }
        const auth=await response.json().catch(()=>null);
        if(!response.ok||auth?.schema!=='QSYN-UPSTOX-INSTRUMENT-RUST-TICKET/1'||
          auth.instrument_key!==this.instrument.instrument_key||
          auth.websocket_path!=='/qsyn/ws/personal-index'||
          auth.trading_enabled!==false||
          typeof auth.ticket!=='string'||auth.ticket.length>512)
          throw Error('UPSTOX_LIVE_TICKET_UNAVAILABLE');
        if(stopped||controller.signal.aborted)return;
        const url=new URL(auth.websocket_path,window.location.origin);
        url.protocol=window.location.protocol==='https:'?'wss:':'ws:';
        socket=new WebSocket(url.href);
        socket.onopen=()=>{
          if(!stopped)socket.send(JSON.stringify({ticket:auth.ticket}));
          this.onStatus('Rust Upstox V3 full feed connected · awaiting provider 1m OHLCV');
        };
        socket.onmessage=message=>{
          if(stopped||this.closed)return;
          let data;try{data=JSON.parse(message.data);}catch{return;}
          if(!validScopedLive(data,this.instrument.instrument_key,lastTime,lastVolume))return;
          const bar=data.bar;
          if(bar.time===lastTime&&bar.volume===lastVolume)return;
          lastTime=bar.time;lastVolume=bar.volume;
          retryDelay=2000;
          onBar({...bar,volume_available:data.volume_available,
            open_interest:data.open_interest});
          this.onStatus('Provider Upstox 1m · '+new Date(data.provider_time_ms)
            .toLocaleTimeString('en-GB',{timeZone:'Asia/Kolkata'})+' IST');
        };
        socket.onerror=()=>{if(!stopped)this.onStatus('UPSTOX_LIVE_SOCKET_UNAVAILABLE');};
        socket.onclose=()=>{if(!stopped)reconnect();};
      }catch(error){
        if(!stopped&&!controller.signal.aborted){
          this.onStatus(error?.message||'UPSTOX_LIVE_UNAVAILABLE');reconnect();
        }
      }
    };
    req.signal?.addEventListener('abort',stop,{once:true});
    void connect();
    return ()=>{req.signal?.removeEventListener('abort',stop);stop();};
  }
  destroy(){this.closed=true;for(const c of this.controllers)c.abort();this.controllers.clear();}
}

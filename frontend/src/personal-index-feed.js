import {inRegularIndexSession} from './index-regular-session.js';
import {subscribeLiveMarketFeed} from './live-market-feed-toggle.js';

/** Match the PHP personal-index gateway for BOTH history and live tickets.
 * Owner-only viewers send a view-only marker; administrator sessions send
 * their CSRF proof. Never send either privilege into the other mode.
 */
export function personalIndexRequestHeaders(ownerViewer,csrf){
  return {
    'Content-Type':'application/json',
    'Accept':'application/json',
    ...(ownerViewer?{'X-QSYN-View-Only':'1'}:{'X-CSRF-Token':csrf})
  };
}

export class PrivateIndexHistoryFeed {
  constructor({symbol,day,csrf,onStatus,onLive=()=>{},ownerViewer=false}){
    this.symbol=symbol;this.day=day;this.csrf=csrf;this.onStatus=onStatus;
    this.ownerViewer=ownerViewer;
    this.onLive=onLive;
    this.closed=false;this.controllers=new Set();
  }
  async getBars(req){
    if(this.closed||req.symbol!==this.symbol||
      req.exchange!=='UPSTOX_PERSONAL')return [];
    if(req.interval==='1s')return []; // Upstox has no historical 1s endpoint
    if(req.interval!=='1m')return [];
    const ctl=new AbortController();
    const abort=()=>ctl.abort();
    req.signal?.addEventListener('abort',abort,{once:true});
    this.controllers.add(ctl);
    try{
      const response=await fetch(this.ownerViewer?'/qsyn/api/v1/owner-index/history':'/qsyn/api/v1/admin/upstox/personal-index/history',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        signal:ctl.signal,headers:personalIndexRequestHeaders(this.ownerViewer,this.csrf),body:JSON.stringify({symbol:this.symbol,day:this.day})
      });
      // An edge/session denial may be HTML rather than JSON. Check status
      // before parsing so lost access never looks like an ordinary outage.
      if(response.status===401||response.status===403)
        throw Error('PRIVATE_INDEX_ACCESS_DENIED');
      const json=await response.json();
      if(!response.ok)throw Error(json.error||'PRIVATE_INDEX_HISTORY_UNAVAILABLE');
      if(json.schema!=='QSYN-UPSTOX-RUST-INDEX-HISTORY/1'||
        json.source!=='upstox_v3_rust_history'||
        json.volume_available===true||
        (json.volume_status!==undefined&&json.volume_status!=='not_applicable_index')||
        json.public_redistribution_allowed!==false||
        json.trading_enabled!==false||
        json.symbol!==this.symbol||json.day_ist!==this.day||json.interval!=='1m'||
        !Array.isArray(json.bars)||json.bars.length>400)
        throw Error('PRIVATE_INDEX_HISTORY_INVALID');
      let previous=0;
      for(const bar of json.bars){
        if(!Number.isSafeInteger(bar?.time)||bar.time%60!==0||bar.time<=previous||
          !['open','high','low','close','volume'].every(k=>Number.isFinite(bar[k]))||
          bar.open<=0||bar.low<=0||bar.close<=0||bar.volume!==0||
          bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))
          throw Error('PRIVATE_INDEX_CANDLE_INVALID');
        previous=bar.time;
      }
      if(!this.closed&&!ctl.signal.aborted&&json.bars.length===0){
        this.onStatus('UPSTOX_NO_CANDLES_FOR_SELECTED_DATE');
        return [];
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
      // Scroll-back must distinguish missing trading-day candles from
      // a rejected history request, not permanently mark provider failure
      // as exhausted history.
      if(req.strictHistory===true)throw e;
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
       !['1m','1s'].includes(req.interval)||this.day!==todayIst())return ()=>{};
    return subscribeLiveMarketFeed(()=>this._subscribeBarsActive(req,onBar));
  }
  _subscribeBarsActive(req,onBar){
    if(this.closed||req.symbol!==this.symbol||req.exchange!=='UPSTOX_PERSONAL'||
       !['1m','1s'].includes(req.interval)||this.day!==todayIst())return ()=>{};
    const controller=new AbortController();
    let stopped=false,socket=null,lastTimestamp=0,retryDelay=2000,reconnectTimer=null;
    this.controllers.add(controller);
    const tickClock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    let lastStatusSecond=-1;
    const scheduleReconnect=()=>{
      if(stopped||this.closed||controller.signal.aborted)return;
      if(reconnectTimer!==null)clearTimeout(reconnectTimer);
      // No broker ticket, Upstox redirect or WSS handshake outside
      // the regular session. Avoid reconnect churn and API quota waste.
      const inSession=inRegularIndexSession();
      if(!inSession)
        this.onLive('Outside regular 09:15–15:30 IST session · live reconnect paused');
      reconnectTimer=setTimeout(()=>{
        reconnectTimer=null;
        void connect();
      },inSession?retryDelay:60000);
      if(inSession)retryDelay=Math.min(retryDelay*2,30000);
    };
    const connect=async()=>{
      if(stopped||this.closed||controller.signal.aborted)return;
      if(!inRegularIndexSession()){
        scheduleReconnect();
        return;
      }
      try{
        const response=await fetch(this.ownerViewer?'/qsyn/api/v1/owner-index/ticket':'/qsyn/api/v1/admin/upstox/personal-index/ticket',{
          method:'POST',credentials:'same-origin',cache:'no-store',
          signal:controller.signal,
          headers:personalIndexRequestHeaders(this.ownerViewer,this.csrf),
          body:JSON.stringify({symbol:this.symbol})
        });
        if(response.status===401||response.status===403){
          // Revoked index access is terminal for this socket. Do not keep
          // requesting owner/admin tickets after the server denies access.
          this.onLive('PRIVATE_INDEX_ACCESS_DENIED');
          stop();
          return;
        }
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
          const bar=req.interval==='1s'?data?.bar_1s:data?.bar;
          if(data?.schema!=='QSYN-RUST-PERSONAL-INDEX-TICK/1'||
             data?.source!=='upstox_v3_websocket'||data?.symbol!==this.symbol||
             data?.trading_enabled!==false||data?.volume_available===true||
             (data?.volume_status!==undefined&&data.volume_status!=='not_applicable_index')||
             bar?.volume!==0||!Number.isSafeInteger(data.time_ms)||
             data.time_ms<lastTimestamp||!Number.isFinite(data.price)||data.price<=0||
             !Number.isSafeInteger(bar?.time)||bar.time!==Math.floor(data.time_ms/(req.interval==='1s'?1000:60000))*(req.interval==='1s'?1:60)||
             !['open','high','low','close'].every(k=>Number.isFinite(bar[k]))||
             bar.open<=0||bar.high<Math.max(bar.open,bar.close)||
             bar.low>Math.min(bar.open,bar.close)||bar.low<=0)
            return;
          if(req.interval==='1m'&&data.time_ms===lastTimestamp)return;
          lastTimestamp=data.time_ms;
          retryDelay=2000;
          onBar(bar);
          const second=Math.floor(data.time_ms/1000);
          if(second!==lastStatusSecond){
            lastStatusSecond=second;
            this.onLive('Rust Upstox V3 tick · '+tickClock.format(new Date(data.time_ms))+' IST');
          }
        };
        socket.onerror=()=>{
          if(!stopped)this.onLive('RUST_UPSTOX_WEBSOCKET_UNAVAILABLE');
        };
        socket.onclose=event=>{
          if(stopped)return;
          if(inRegularIndexSession()){
            this.onLive(event?.code===1006
              ? 'Rust WebSocket closed abnormally · checking connection'
              : 'Rust WebSocket disconnected · reconnecting');
          }
          scheduleReconnect();
        };
      }catch(e){
        if(!stopped&&!controller.signal.aborted){
          this.onLive(/^[a-z0-9_]{3,90}$/i.test(e.message||'')
            ?e.message:'RUST_PERSONAL_DATA_UNAVAILABLE');
          scheduleReconnect();
        }
      }
    };
    void connect();
    const stop=()=>{
      stopped=true;controller.abort();
      if(reconnectTimer!==null)clearTimeout(reconnectTimer);
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


export function todayIst(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=type=>parts.find(p=>p.type===type)?.value;
  return get('year')+'-'+get('month')+'-'+get('day');
}

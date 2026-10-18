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
  subscribeBars(){return ()=>{};}
  destroy(){this.closed=true;for(const c of this.controllers)c.abort();this.controllers.clear();}
}

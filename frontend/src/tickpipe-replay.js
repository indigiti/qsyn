export const MAX_REPLAY_BYTES=32*1024*1024;

export function decodeReplay(text){
  if(typeof text!=='string'||text.length>MAX_REPLAY_BYTES)throw Error('Replay file is too large.');
  const data=JSON.parse(text);
  if(data?.schema!=='QSYN-TICKPIPE-REPLAY/1'||data.source!=='openalgo_snapshot'||
    data.mode!=='offline_only'||data.candle_clock!=='receive_time_utc'||
    !/^[A-Z0-9_]{1,16}:[A-Z0-9_&.-]{1,64}$/.test(data.symbol??'')||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date_utc??'')||
    !Array.isArray(data.sequence_gaps))throw Error('Unsupported TickPipe replay bundle.');
  const day=Date.parse(data.date_utc+'T00:00:00Z')/1000;
  if(!Number.isFinite(day)||new Date(day*1000).toISOString().slice(0,10)!==data.date_utc)
    throw Error('Invalid replay date.');
  const candles={};
  for(const seconds of [1,60]){
    const source=data.candles?.[seconds];
    if(!Array.isArray(source)||!source.length||source.length>86400/seconds)
      throw Error('Missing or invalid candle series.');
    let previous=day-1;
    candles[seconds]=source.map(bar=>{
      if(!bar)throw Error('Invalid replay candle.');
      const {time,open,high,low,close}=bar;
      if(!Number.isSafeInteger(time)||time<=previous||time>=day+86400||time%seconds||
        ![open,high,low,close].every(value=>Number.isFinite(value)&&value>0)||
        high<Math.max(open,close)||low>Math.min(open,close))
        throw Error('Invalid or unordered replay candle.');
      previous=time;
      return {time,open,high,low,close};
    });
  }
  return {symbol:data.symbol,date:data.date_utc,candles,gaps:data.sequence_gaps.length};
}

export function advanceReplay(cursor,count){
  return Math.min(cursor+1,count);
}

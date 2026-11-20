import React,{useEffect,useRef,useState} from 'react';
import {advanceReplay,decodeReplay,MAX_REPLAY_BYTES} from './tickpipe-replay.js';

function ReplayPlot({bars,seconds}){
  if(!bars.length)return <p>Press Play or Step to reveal the first recorded candle.</p>;
  const high=Math.max(...bars.map(b=>b.high)),low=Math.min(...bars.map(b=>b.low));
  const y=p=>high===low?100:15+170*((high-p)/(high-low));
  const newest=bars.at(-1),origin=newest.time-119*seconds;
  return <svg viewBox="0 0 720 200" width="100%" role="img"
    aria-label={'Snapshot-derived candlestick chart. Last close '+newest.close}>
    {bars.map(b=>{
      const x=(b.time-origin)*6+3;
      const color=b.close>=b.open?'#16865c':'#d05252';
      return <g key={b.time}><title>{new Date(b.time*1000).toISOString()} UTC · O {b.open} H {b.high} L {b.low} C {b.close}</title>
        <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={color}/>
        <rect x={x-2} width={4} y={Math.min(y(b.open),y(b.close))}
          height={Math.max(1,Math.abs(y(b.open)-y(b.close)))} fill={color}/></g>;
    })}
  </svg>;
}

export function TickPipeReplay(){
  const [bundle,setBundle]=useState(null),[error,setError]=useState('');
  const [seconds,setSeconds]=useState(1),[cursor,setCursor]=useState(0);
  const [playing,setPlaying]=useState(false),[speed,setSpeed]=useState(5);
  const loadVersion=useRef(0);
  const series=bundle?.candles[seconds];
  const count=series?.length??0;
  const last=cursor?series?.[cursor-1]:null;
  const visible=last?series.slice(Math.max(0,cursor-120),cursor)
    .filter(b=>b.time>=last.time-119*seconds):[];
  useEffect(()=>{
    if(!playing||cursor>=count)return;
    const timer=setTimeout(()=>setCursor(c=>advanceReplay(c,count)),1000/speed);
    return()=>clearTimeout(timer);
  },[playing,cursor,count,speed]);
  useEffect(()=>{if(cursor>=count)setPlaying(false);},[cursor,count]);
  useEffect(()=>()=>{loadVersion.current++;},[]);
  function reset(){setPlaying(false);setCursor(0);}
  async function select(event){
    const file=event.currentTarget.files?.[0];
    event.currentTarget.value='';
    if(!file)return;
    const version=++loadVersion.current;
    reset();setBundle(null);setError('');
    try{
      if(file.size>MAX_REPLAY_BYTES)throw Error('Replay file exceeds 32 MiB.');
      const decoded=decodeReplay(await file.text());
      if(version===loadVersion.current)setBundle(decoded);
    }catch{
      if(version===loadVersion.current)setError('Replay file rejected. Select a valid TickPipe JSON bundle under 32 MiB.');
    }
  }
  return <section className="terminal-surface">
    <h2>TickPipe replay</h2>
    <p>Snapshot-derived, offline only. Files stay in this tab; nothing is uploaded or saved.</p>
    <label>Local replay bundle <input type="file" accept=".json,application/json" onChange={select}/></label>
    {error&&<p role="alert">{error}</p>}
    {bundle&&<>
      <p><strong>{bundle.symbol}</strong> · {bundle.date} UTC · {bundle.gaps} sequence gap ranges. Exchange coverage is unknown.</p>
      <label>Candle interval <select value={seconds} onChange={e=>{reset();setSeconds(Number(e.target.value));}}>
        <option value={1}>1 second</option><option value={60}>1 minute</option>
      </select></label>{' '}
      <label>Playback <select value={speed} onChange={e=>setSpeed(Number(e.target.value))}>
        <option value={1}>1 candle/s</option><option value={5}>5 candles/s</option><option value={20}>20 candles/s</option>
      </select></label>{' '}
      <button type="button" disabled={cursor>=count} onClick={()=>setPlaying(!playing)}>{playing?'Pause':'Play'}</button>{' '}
      <button type="button" disabled={cursor>=count} onClick={()=>{setPlaying(false);setCursor(c=>advanceReplay(c,count));}}>Step</button>{' '}
      <button type="button" onClick={reset}>Reset</button>{' '}
      <button type="button" onClick={()=>{loadVersion.current++;reset();setBundle(null);}}>Clear</button>
      <p>{cursor} / {count} recorded candles{last?' · '+new Date(last.time*1000).toISOString():''}</p>
      <ReplayPlot bars={visible} seconds={seconds}/>
    </>}
  </section>;
}

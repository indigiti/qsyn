import React,{useState} from 'react';
import {PREMIUM_PRESET,parsePremiumCsv,replayPremiumStrategy} from './premium-breakout-core.js';

const editable=[
  ['buyAbove','Buy PE above'],['buyStop','Buy PE stop'],
  ['shortBelow','Short PE below'],['shortStop','Short PE stop'],
  ['partialR','Half profit at R'],['volumeMultiplier','Volume multiplier'],
  ['volumeLookback','Volume lookback bars']
];
export function PremiumBreakoutResearch(){
  const [rules,setRules]=useState({...PREMIUM_PRESET});
  const [csv,setCsv]=useState('');
  const [out,setOut]=useState(null);
  const [error,setError]=useState('');
  const update=(key,value)=>{setRules(s=>({...s,[key]:value}));setOut(null);};
  function replay(){
    setOut(null);setError('');
    try {
      if(!csv.trim())throw Error('Import actual option 1-minute CSV candles before replay.');
      setOut(replayPremiumStrategy(parsePremiumCsv(csv),rules));
    }catch(e){setError(e.message);}
  }
  async function upload(file){
    setError('');setOut(null);
    if(!file)return;
    if(file.size>2000000){setError('CSV exceeds 2 MB.');return;}
    setCsv(await file.text());
  }
  return <section className="terminal-surface" aria-label="Premium breakout research">
    <div className="terminal-card-head"><h2>Premium Breakout · Reverse-engineered preset</h2>
      <span className="terminal-chip">RESEARCH ONLY · NO ORDERS</span></div>
    <p className="terminal-footnote">Hypothesis from 12 Oct 2026: 23000 PE long above ₹402 / short below ₹386 with 16-point opening stop separation. This is not a verified trading edge. Input option-contract candles, not NIFTY spot or synthetic candles. Prices are illustrative and must be adjusted for each contract and session.</p>
    <div className="qt-actions qt-field-row">
      {editable.map(([key,label])=><label key={key}>{label}<input
        aria-label={label} type="number" step={key==='volumeLookback'?'1':'0.01'}
        value={rules[key]} onChange={e=>update(key,Number(e.target.value))}
        style={{width:116,background:'var(--q-bg)',color:'var(--q-fg)',border:'1px solid var(--q-line)',borderRadius:6,padding:8}} /></label>)}
      <label>Directions<select aria-label="Premium directions" value={rules.directions}
        onChange={e=>update('directions',e.target.value)}>
        <option value="BOTH">Both</option><option value="LONG">Long only</option>
        <option value="SHORT">Short only</option></select></label>
    </div>
    <div className="qt-actions">
      <label><input type="checkbox" checked={rules.useVolume}
        onChange={e=>update('useVolume',e.target.checked)}/> Require volume expansion</label>
      <label><input type="checkbox" checked={rules.useOi}
        onChange={e=>update('useOi',e.target.checked)}/> Require rising OI (exploratory)</label>
    </div>
    <p className="terminal-footnote">Rule: signal on completed 1m premium close crossing its trigger; entry at next 1m open. Initial stop first on ambiguous candles; 50% scale-out at configured R, then trail using prior completed bar. No fees, slippage, contract quantities, real broker execution, or live feed. Rising OI is not directional proof.</p>
    <div className="qt-actions qt-field-row">
      <label>Import option 1m CSV (time,open,high,low,close,volume,oi optional)
        <input type="file" accept=".csv,text/csv" aria-label="Option minute CSV"
          onChange={e=>void upload(e.target.files?.[0])}/></label>
      <button type="button" className="terminal-action" onClick={replay}>Replay imported candles</button>
      <button type="button" className="terminal-action terminal-secondary-action"
        onClick={()=>{setRules({...PREMIUM_PRESET});setOut(null);setError('');}}>Reset preset</button>
    </div>
    {error&&<p role="alert" className="terminal-error">{error}</p>}
    {out&&<div>
      <div className="qt-summary">
        <section className="terminal-surface"><span>Completed trades</span><strong>{out.summary.completed}</strong></section>
        <section className="terminal-surface"><span>Win rate</span><strong>{out.summary.winRate===null?'—':(out.summary.winRate*100).toFixed(1)+'%'}</strong></section>
        <section className="terminal-surface"><span>Gross weighted points</span><strong>{out.summary.realizedPoints.toFixed(2)}</strong></section>
      </div>
      {out.openPosition&&<p className="terminal-footnote">Last position remains OPEN / unverified exit, excluded from realized P&amp;L. Unrealized points: {out.openPosition.unrealizedAtLastClose.toFixed(2)}</p>}
      <div className="qt-table-wrap"><table className="qt-table"><thead>
        <tr><th>Side</th><th>Entry</th><th>Price</th><th>Partial</th><th>Final exit</th><th>Reason</th><th>Points</th><th>R</th></tr>
      </thead><tbody>{out.trades.map((t,i)=><tr key={i}>
        <td>{t.side}</td><td>{new Date(t.entryTime).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</td>
        <td>{t.entry.toFixed(2)}</td><td>{t.firstExit?.toFixed(2)??'—'}</td>
        <td>{t.exit.toFixed(2)}</td><td>{t.exitReason}</td><td>{t.points.toFixed(2)}</td><td>{t.r.toFixed(2)}</td>
      </tr>)}</tbody></table></div>
      <p className="terminal-footnote">CSV replay is provisional: no market-data validation, fees, slippage, lot P&amp;L or intrabar tick ordering. Option OI/volume feed connectivity remains unverified.</p>
    </div>}
  </section>;
}

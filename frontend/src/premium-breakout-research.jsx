import React,{useState} from 'react';
import {PREMIUM_PRESET,parsePremiumCsv,replayPremiumStrategy} from './premium-breakout-core.js';

const editable=[
  ['buyAbove','PE long above'],['buyStop','PE long stop'],
  ['shortBelow','PE short below'],['shortStop','PE short stop'],
  ['autoBuffer','Auto pivot buffer'],['partialR','Half profit at R'],
  ['volumeMultiplier','Volume multiplier'],['volumeLookback','Volume lookback bars']
];
const numberInputStyle={width:120,background:'var(--q-bg)',color:'var(--q-fg)',
  border:'1px solid var(--q-line)',borderRadius:6,padding:8};

export function PremiumBreakoutResearch(){
  const [rules,setRules]=useState({...PREMIUM_PRESET});
  const [csv,setCsv]=useState(''),[trendCsv,setTrendCsv]=useState('');
  const [out,setOut]=useState(null),[error,setError]=useState('');
  const [optionName,setOptionName]=useState(''),[trendName,setTrendName]=useState('');
  const update=(key,value)=>{setRules(s=>({...s,[key]:value}));setOut(null);};
  function replay(){
    setOut(null);setError('');
    try{
      if(!csv.trim())throw Error('Import actual option-contract 1m CSV before replay.');
      const bars=parsePremiumCsv(csv);
      const trend=rules.trendMode==='OFF'?null:parsePremiumCsv(trendCsv);
      setOut(replayPremiumStrategy(bars,rules,trend));
    }catch(e){setError(e.message);}
  }
  async function upload(file,kind){
    setError('');setOut(null);
    if(!file)return;
    if(file.size>2000000){setError('CSV exceeds 2 MB.');return;}
    try{
      const content=await file.text();
      parsePremiumCsv(content);
      if(kind==='option'){setCsv(content);setOptionName(file.name);}
      else{setTrendCsv(content);setTrendName(file.name);}
    }catch(e){setError('Cannot import '+kind+' candles: '+e.message);}
  }
  return <section className="terminal-surface" aria-label="Premium breakout research">
    <div className="terminal-card-head"><h2>Premium Breakout · Reverse-engineered strategy</h2>
      <span className="terminal-chip">RESEARCH ONLY · NO ORDERS</span></div>
    <p className="terminal-footnote">Research hypothesis from 12 Oct 2026: NIFTY 23000 PE long above ₹402 / short below ₹386. Manual trigger values are illustrative, not proven daily signals. Automated levels derive only from a complete previous session of the same option contract.</p>
    <div className="qt-actions qt-field-row">
      <label>Trigger discovery<select aria-label="Premium trigger discovery" value={rules.mode}
        onChange={e=>update('mode',e.target.value)}>
        <option value="MANUAL">Manual (₹402 / ₹386)</option>
        <option value="PREVIOUS_LOW">Previous complete session low ± buffer</option>
        <option value="PREVIOUS_RANGE">Previous complete session high / low ± buffer</option>
      </select></label>
      <label>Trade side<select aria-label="Premium directions" value={rules.directions}
        onChange={e=>update('directions',e.target.value)}>
        <option value="BOTH">PE buy + PE short</option>
        <option value="LONG">PE buy only</option>
        <option value="SHORT">PE short only</option>
      </select></label>
      <label>NIFTY/Synthetic trend<select aria-label="Underlying trend filter" value={rules.trendMode}
        onChange={e=>update('trendMode',e.target.value)}>
        <option value="OFF">Off</option>
        <option value="EMA21">Price + EMA 21</option>
        <option value="EMA21_90">Price + EMA 21/90</option>
      </select></label>
    </div>
    <div className="qt-actions qt-field-row">
      {editable.filter(([key])=>rules.mode==='MANUAL'?key!=='autoBuffer':
        !['buyAbove','buyStop','shortBelow','shortStop'].includes(key)).map(([key,label])=>
        <label key={key}>{label}<input aria-label={label} type="number"
          min={key==='volumeLookback'?2:0.01} step={key==='volumeLookback'?'1':'0.01'}
          value={rules[key]} onChange={e=>update(key,Number(e.target.value))}
          style={numberInputStyle}/></label>)}
    </div>
    <div className="qt-actions">
      <label className="qt-checkbox"><input type="checkbox" checked={rules.useVolume}
        onChange={e=>update('useVolume',e.target.checked)}/> Require option volume expansion</label>
      <label className="qt-checkbox"><input type="checkbox" checked={rules.useOi}
        onChange={e=>update('useOi',e.target.checked)}/> Require rising option OI (experimental)</label>
    </div>
    <p className="terminal-footnote">Auto mode: requires exactly 375 contiguous previous-session candles from 09:15–15:29 IST. Previous-low mode tests the hypothesis of an eight-point band around the prior low; previous-range mode uses high + buffer and low − buffer. Levels are not known before that complete session ends. Shorting an option has substantial margin and gap risk.</p>
    <div className="qt-actions qt-field-row">
      <label>Option contract · 1m CSV
        <input aria-label="Option minute CSV" type="file" accept=".csv,text/csv"
          onChange={e=>void upload(e.target.files?.[0],'option')}/></label>
      {rules.trendMode!=='OFF'&&<label>NIFTY Spot/Synthetic · 1m CSV
        <input aria-label="NIFTY or synthetic trend CSV" type="file" accept=".csv,text/csv"
          onChange={e=>void upload(e.target.files?.[0],'trend')}/></label>}
    </div>
    <p className="terminal-footnote">Input columns: time,open,high,low,close,volume,oi (oi optional). Time must have timezone offset. Both files stay in this browser. {optionName?'Option: '+optionName+'. ':''}{trendName&&rules.trendMode!=='OFF'?'Trend: '+trendName+'. ':''}Trend filter checks the exact completed signal candle; no missing-bar interpolation. EMA 21/90 needs at least 90 supplied bars of historical warm-up.</p>
    <div className="qt-actions">
      <button type="button" className="terminal-action" onClick={replay}>Run historical replay</button>
      <button type="button" className="terminal-action terminal-secondary-action"
        onClick={()=>{setRules({...PREMIUM_PRESET});setOut(null);setError('');}}>Reset strategy preset</button>
    </div>
    {error&&<p role="alert" className="terminal-error">{error}</p>}
    {out&&<>
      <div className="qt-summary">
        <section className="terminal-surface"><span>Completed trades</span><strong>{out.summary.completed}</strong></section>
        <section className="terminal-surface"><span>Win rate</span><strong>{out.summary.winRate===null?'—':(out.summary.winRate*100).toFixed(1)+'%'}</strong></section>
        <section className="terminal-surface"><span>Gross weighted points</span><strong>{out.summary.realizedPoints.toFixed(2)}</strong></section>
      </div>
      <div className="qt-table-wrap"><table className="qt-table"><thead><tr>
        <th>Session</th><th>Reference</th><th>Long above</th><th>Short below</th><th>Source</th>
      </tr></thead><tbody>{out.levels.map(s=><tr key={s.date}>
        <td>{s.date}</td><td>{s.referenceDate??'—'}</td>
        <td>{s.buyAbove?.toFixed(2)??'Unavailable'}</td>
        <td>{s.shortBelow?.toFixed(2)??'Unavailable'}</td>
        <td>{s.source}</td>
      </tr>)}</tbody></table></div>
      {out.openPosition&&<p className="terminal-footnote">Position OPEN (not a completed trade). Unrealized premium points: {out.openPosition.unrealizedAtLastClose.toFixed(2)}.</p>}
      {out.incomplete.length>0&&<p role="status" className="terminal-footnote">{out.incomplete.length} incomplete session positions excluded from realized P&amp;L.</p>}
      <div className="qt-table-wrap"><table className="qt-table"><thead><tr>
        <th>Side</th><th>Entry IST</th><th>Price</th><th>Partial</th><th>Final exit</th><th>Reason</th><th>Points</th><th>R</th>
      </tr></thead><tbody>{out.trades.map((t,i)=><tr key={i}>
        <td>{t.side}</td>
        <td>{new Date(t.entryTime).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</td>
        <td>{t.entry.toFixed(2)}</td><td>{t.firstExit?.toFixed(2)??'—'}</td>
        <td>{t.exit.toFixed(2)}</td><td>{t.exitReason}</td>
        <td>{t.points.toFixed(2)}</td><td>{t.r.toFixed(2)}</td>
      </tr>)}</tbody></table></div>
      <p className="terminal-footnote">Provisional OHLC replay only: exact intrabar order, realistic order fills, brokerage, margin, taxes, option lot sizing and slippage are not modeled. The OI filter checks only rising reported OI; it cannot establish buyer or seller intent. Nothing is sent to a broker.</p>
    </>}
  </section>;
}

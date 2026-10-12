import React,{useEffect,useRef,useState} from 'react';
import {Activity,CandlestickChart,Layers,Plus,Save,Trash2} from 'lucide-react';
import {createWidget} from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';
import './terminal-unified.css';
import {PremiumBreakoutResearch} from './premium-breakout-research.jsx';

const UNDERLYINGS=['NIFTY','BANKNIFTY','FINNIFTY'];
const HORIZONS=['W1','W2','M1'];
const INTERVALS=['1m','5m','15m'];
const LOCAL='qsyn-unified-strategies-v1';
const money=x=>typeof x==='number'?x.toLocaleString('en-IN',{maximumFractionDigits:2}):'—';
const initialLegs=(market,strangle=false)=>[
  {type:'CE',side:'BUY',strike:market.atm+(strangle?market.strike_step:0),qty:1},
  {type:'PE',side:'BUY',strike:market.atm-(strangle?market.strike_step:0),qty:1},
];
const contractValid=(v,market)=>{
  if(!v||!Array.isArray(v.legs)||!v.legs.length||v.legs.length>4||
      !HORIZONS.includes(v.expiry)||!INTERVALS.includes(v.interval))return false;
  const ids=new Set();
  return v.legs.every(x=>{
    const id=x.type+':'+x.strike;
    if(ids.has(id))return false;
    ids.add(id);
    return ['CE','PE'].includes(x.type)&&['BUY','SELL'].includes(x.side)
      &&Number.isInteger(x.qty)&&x.qty>=1&&x.qty<=5
      &&market.chain.some(row=>row.strike===x.strike);
  });
};
async function simulation(path,signal){
  const response=await fetch('/qsyn/api/v1/studio/'+path,{
    credentials:'same-origin',cache:'no-store',signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('Simulation endpoint unavailable ('+response.status+')');
  const data=await response.json();
  if(data.mode!=='simulated'||data.source!=='deterministic-options-laboratory'||
      data.trading_enabled!==false||data.broker_connected!==false)
    throw Error('Unexpected data source; strategy chart blocked');
  return data;
}
function StrategyChart({series,interval,theme}) {
  const host=useRef(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    if(!series||!host.current)return;
    let live=true,widget=null;
    const bars=series.bars, symbol=series.symbol;
    try {
      widget=createWidget(host.current,{
        feed:{getBars:async req=>req.symbol===symbol&&req.interval===interval?bars:[],
          subscribeBars:()=>()=>{}},
        symbol,exchange:'QSYN',interval,intervals:INTERVALS,theme,
        branding:false,persist:false,panels:true,
        navigation:{defaultVisibleBars:90,mousePan:'horizontal'},
      });
      void widget.ready.catch(()=>{if(live)setError('Strategy chart not available');});
    }catch{setError('OpenAlgo chart could not mount');}
    return ()=>{live=false;try{widget?.destroy();}catch{}};
  },[series,interval,theme]);
  return <section className="terminal-surface qt-strategy-chart">
    <div className="terminal-card-head"><h2>Combined option premium · simulated OHLCV</h2>
      <span className="terminal-chip">NO LIVE ORDERS</span></div>
    <div className="qt-strategy-canvas" ref={host} aria-label="Synthetic strategy candlestick chart"/>
    {error&&<p role="alert" className="terminal-error">{error}</p>}
  </section>;
}
function Payoff({points}){
  if(!Array.isArray(points)||!points.length)return null;
  const minX=Math.min(...points.map(p=>p.spot)),maxX=Math.max(...points.map(p=>p.spot));
  const minY=Math.min(...points.map(p=>p.pnl),0),maxY=Math.max(...points.map(p=>p.pnl),0);
  const rangeX=maxX-minX||1,rangeY=maxY-minY||1;
  const x=p=>30+(p.spot-minX)/rangeX*420;
  const y=p=>165-(p.pnl-minY)/rangeY*140;
  const path=points.map((p,i)=>(i?'L':'M')+x(p)+' '+y(p)).join(' ');
  const zero=165-(0-minY)/rangeY*140;
  return <section className="terminal-surface">
    <div className="terminal-card-head"><h2>Expiry payoff · hypothetical P/L</h2>
      <small>Fictional reference points</small></div>
    <svg className="qt-payoff" viewBox="0 0 480 190" role="img"
      aria-label="Simulated expiry payoff for current strategy">
      <path d={'M30 '+zero+' H455'} stroke="currentColor" strokeDasharray="4 6" opacity=".35"/>
      <path d={path} fill="none" stroke="#28a8a0" strokeWidth="2.5"/>
      <text x="30" y="182" fill="currentColor" fontSize="10">{money(minX)}</text>
      <text x="455" y="182" fill="currentColor" fontSize="10" textAnchor="end">{money(maxX)}</text>
    </svg>
    <p className="terminal-footnote">Hypothetical points exclude transaction costs, contract lot sizes, exchange prices and live Greeks.</p>
  </section>;
}
function fetchSaved(){
  try {
    const data=JSON.parse(localStorage.getItem(LOCAL)||'[]');
    if(Array.isArray(data))return data.filter(x=>x&&typeof x.name==='string'&&
      UNDERLYINGS.includes(x.underlying)&&x.name.length<=40&&
      x.legs?.length<=4).slice(0,12);
  }catch{}
  return [];
}
export function StrategyWorkspace({theme}){
  const [underlying,setUnderlying]=useState('NIFTY');
  const [expiry,setExpiry]=useState('W1'),[interval,setInterval]=useState('1m');
  const [market,setMarket]=useState(null),[legs,setLegs]=useState([]);
  const [series,setSeries]=useState(null),[result,setResult]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [saved,setSaved]=useState(fetchSaved),[name,setName]=useState('');
  const latestRef=useRef(0);
  function invalidate(){
    latestRef.current++;
    setBusy(false);setResult(null);setSeries(null);
  }
  useEffect(()=>{
    invalidate();
    const a=new AbortController();
    setMarket(null);setLegs([]);setResult(null);setSeries(null);setError('');
    void simulation('market?underlying='+encodeURIComponent(underlying),a.signal)
      .then(data=>{
        if(a.signal.aborted)return;
        if(data.underlying!==underlying||!Array.isArray(data.chain)||data.chain.length<5)
          throw Error('Invalid simulated option chain');
        setMarket(data);setLegs(initialLegs(data));
      }).catch(e=>{if(!a.signal.aborted)setError(e.message);});
    return ()=>a.abort();
  },[underlying]);
  useEffect(()=>()=>{latestRef.current++;},[]);
  async function render(){
    const config={expiry,interval,legs};
    if(!market||!contractValid(config,market)){setError('Select 1–4 distinct simulated contracts with valid strikes and quantities.');return;}
    const serial=++latestRef.current;
    setBusy(true);setError('');
    try{
      const query=new URLSearchParams({underlying,expiry,interval,legs:JSON.stringify(legs)});
      const data=await simulation('bars?'+query);
      if(serial!==latestRef.current)return;
      if(data.underlying!==underlying||data.expiry!==expiry||
          data.interval!==interval||!Array.isArray(data.bars)||
          data.bars.length!==120||!Array.isArray(data.legs)||
          data.legs.length!==legs.length||data.synthetic_extrema!=='synchronized_15_second_samples'||
          !Array.isArray(data.payoff)||data.payoff.length!==21)
        throw Error('Simulated strategy contract validation failed');
      if(data.bars.some((b,i)=>!Number.isSafeInteger(b.time)||!Number.isFinite(b.close)||
          b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||
          (i>0&&b.time<=data.bars[i-1].time)))
        throw Error('Invalid simulated candle data');
      setResult(data);setSeries({symbol:data.symbol,bars:data.bars});
    }catch(e){if(serial===latestRef.current){setResult(null);setSeries(null);setError(e.message);}}
    finally{if(serial===latestRef.current)setBusy(false);}
  }
  function modify(index,key,value){
    setLegs(previous=>previous.map((x,i)=>i===index?{...x,[key]:value}:x));
    invalidate();
  }
  function addLeg(){
    if(!market||legs.length>=4)return;
    const candidate=market.chain.flatMap(c=>[
      {type:'CE',side:'BUY',strike:c.strike,qty:1},
      {type:'PE',side:'BUY',strike:c.strike,qty:1}]).find(x=>
        !legs.some(l=>l.type===x.type&&l.strike===x.strike));
    if(candidate)setLegs(v=>[...v,candidate]);
    invalidate();
  }
  function save(){
    if(!name.trim()||name.length>40||!market||!contractValid({expiry,interval,legs},market))
      {setError('Enter a name and valid strategy before saving.');return;}
    const next=[{name:name.trim(),underlying,expiry,interval,legs:legs.map(x=>({...x}))},
      ...saved.filter(x=>x.name!==name.trim())].slice(0,12);
    try{localStorage.setItem(LOCAL,JSON.stringify(next));setSaved(next);setError('');}
    catch{setError('Browser-local storage unavailable');}
  }
  function restore(template){
    setUnderlying(template.underlying);setExpiry(template.expiry);setInterval(template.interval);
    // Templates from another underlying are resolved only after that
    // instrument's known demo chain loads; no broker data is imported.
    setPending(template);
  }
  const [pending,setPending]=useState(null);
  useEffect(()=>{
    if(!pending||!market||market.underlying!==pending.underlying)return;
    if(contractValid(pending,market)){setLegs(pending.legs);invalidate();}
    else setError('Saved strategy incompatible with current simulated chain.');
    setPending(null);
  },[market,pending]);
  return <div className="terminal-page qt-unified">
    <header className="terminal-title"><div><p className="terminal-eyebrow">OPTIONS RESEARCH · SIMULATION</p>
      <h1>Strategy Studio</h1><p>Native React research workspace using QSYN's existing simulated premium API. No real NSE/Upstox data or orders.</p></div></header>
    <section className="terminal-surface">
      <div className="qt-actions qt-field-row">
        <label>Underlying<select aria-label="Strategy underlying" value={underlying} onChange={e=>setUnderlying(e.target.value)}>
          {UNDERLYINGS.map(v=><option key={v}>{v}</option>)}</select></label>
        <label>Demo horizon<select aria-label="Strategy horizon" value={expiry} onChange={e=>{setExpiry(e.target.value);invalidate();}}>
          {HORIZONS.map(v=><option key={v}>{v}</option>)}</select></label>
        <label>Interval<select aria-label="Strategy interval" value={interval} onChange={e=>{setInterval(e.target.value);invalidate();}}>
          {INTERVALS.map(v=><option key={v}>{v}</option>)}</select></label>
        <span className="qt-atm">Reference ATM: {market?money(market.atm):'Loading'}</span>
      </div>
      <div className="qt-actions">
        <button className="terminal-action terminal-secondary-action" disabled={!market} onClick={()=>{
          if(market){setLegs(initialLegs(market));invalidate();}
        }}>ATM straddle</button>
        <button className="terminal-action terminal-secondary-action" disabled={!market} onClick={()=>{
          if(market){setLegs(initialLegs(market,true));invalidate();}
        }}>OTM strangle</button>
        <button className="terminal-action terminal-secondary-action" disabled={!market||legs.length>=4} onClick={addLeg}><Plus size={15}/> Add leg</button>
      </div>
      {legs.map((l,i)=><div key={i} className="qt-leg">
        <strong>Leg {i+1}</strong>
        <label>Type<select aria-label={'Leg '+(i+1)+' type'} value={l.type} onChange={e=>modify(i,'type',e.target.value)}>
          <option>CE</option><option>PE</option></select></label>
        <label>Side<select aria-label={'Leg '+(i+1)+' side'} value={l.side} onChange={e=>modify(i,'side',e.target.value)}>
          <option>BUY</option><option>SELL</option></select></label>
        <label>Strike<select aria-label={'Leg '+(i+1)+' strike'} value={l.strike} onChange={e=>modify(i,'strike',Number(e.target.value))}>
          {(market?.chain||[]).map(c=><option key={c.strike} value={c.strike}>{money(c.strike)}</option>)}</select></label>
        <label>Qty<input aria-label={'Leg '+(i+1)+' quantity'} type="number" min="1" max="5" step="1" value={l.qty}
          onChange={e=>modify(i,'qty',Number(e.target.value))}/></label>
        <button type="button" className="terminal-icon" aria-label={'Remove leg '+(i+1)}
          disabled={legs.length<=1} onClick={()=>{setLegs(v=>v.filter((_,j)=>j!==i));invalidate();}}>
          <Trash2 size={17}/></button>
      </div>)}
      <div className="qt-actions">
        <button className="terminal-action" disabled={busy||!market||!legs.length} onClick={()=>void render()}>
          <CandlestickChart size={16}/> {busy?'Calculating…':'Render strategy'}</button>
        <label>Save template<input aria-label="Strategy template name" maxLength={40} value={name}
          onChange={e=>setName(e.target.value)} placeholder="ATM research"/></label>
        <button className="terminal-action terminal-secondary-action" onClick={save}><Save size={16}/> Save</button>
        <label>Saved setup<select aria-label="Saved strategy templates" defaultValue="" onChange={e=>{
          const template=saved.find(x=>x.name===e.target.value);if(template)restore(template);
        }}><option value="">Choose template…</option>{saved.map(x=><option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
      </div>
      {error&&<p role="alert" className="terminal-error">{error}</p>}
      <p className="terminal-footnote">All data here is deterministic simulation. Templates remain in this browser, never in an unscoped private broker workspace.</p>
    </section>
    <PremiumBreakoutResearch/>
    {series&&result&&<>
      <div className="qt-summary">
        <section className="terminal-surface"><Activity size={18}/><span>Basket premium</span><strong>{money(result.bars.at(-1).close)} points</strong></section>
        <section className="terminal-surface"><Layers size={18}/><span>Legs</span><strong>{result.legs.length} demo contracts</strong></section>
        <section className="terminal-surface"><CandlestickChart size={18}/><span>Entry cashflow</span><strong>{money(result.entry_cashflow_points)} points</strong></section>
      </div>
      <StrategyChart series={series} interval={interval} theme={theme}/>
      <Payoff points={result.payoff}/>
    </>}
    {market&&<section className="terminal-surface">
      <div className="terminal-card-head"><h2>Simulated option chain</h2><span className="terminal-chip">FICTIONAL</span></div>
      <div className="qt-table-wrap"><table className="qt-table"><thead><tr><th>CE price</th><th>Strike</th><th>PE price</th></tr></thead>
        <tbody>{market.chain.map(c=><tr key={c.strike} className={c.strike===market.atm?'qt-atm-row':''}>
          <td>{money(c.ce)}</td><td>{money(c.strike)}</td><td>{money(c.pe)}</td></tr>)}</tbody>
      </table></div>
    </section>}
  </div>;
}

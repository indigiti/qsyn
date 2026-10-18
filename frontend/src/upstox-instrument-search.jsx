import React,{useEffect,useState} from 'react';
import {searchUpstoxInstruments} from './upstox-instrument-search.js';
import './upstox-instrument-search.css';

const EXCHANGES=['ALL','NSE','BSE','MCX'];
const SEGMENTS=['ALL','EQ','FO','INDEX','OPT','FUT','CURR','COMM'];
const TYPES=['','CE','PE','FUT','EQ'];
const EXPIRIES=['','current_week','next_week','current_month','next_month'];
export function UpstoxInstrumentSearch(){
  const [query,setQuery]=useState('');
  const [exchange,setExchange]=useState('ALL');
  const [segment,setSegment]=useState('ALL');
  const [type,setType]=useState('');
  const [expiry,setExpiry]=useState('');
  const [page,setPage]=useState(1);
  const [result,setResult]=useState(null);
  const [selected,setSelected]=useState(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  useEffect(()=>{
    const q=query.trim();
    if(q.length<2){setResult(null);setSelected(null);setError('');setLoading(false);return;}
    const controller=new AbortController();
    const timer=setTimeout(()=>{
      setLoading(true);setError('');
      void searchUpstoxInstruments({query:q,exchange,segment,type,expiry,page},
        {signal:controller.signal}).then(value=>{
          if(!controller.signal.aborted){setResult(value);setSelected(null);}
        }).catch(e=>{
          if(!controller.signal.aborted){setResult(null);setSelected(null);
            setError(e?.message||'Instrument search unavailable');}
        }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    },350);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,exchange,segment,type,expiry,page]);
  const reset=setter=>value=>{setter(value);setPage(1);setSelected(null);};
  return <section className="terminal-surface qs-upstox-instruments" aria-label="Upstox symbol search">
    <h2>Search Upstox instruments</h2>
    <p className="terminal-footnote">Discover NSE, BSE and MCX symbols and individual
      futures/options contracts. Results come from Upstox instrument search,
      not from simulated market prices.</p>
    <div className="qs-upstox-search-filters">
      <label>Symbol, company or ISIN
        <input aria-label="Search Upstox symbols" type="search" autoComplete="off"
          maxLength={50} value={query} placeholder="NIFTY, RELIANCE, SENSEX…"
          onChange={e=>reset(setQuery)(e.target.value)}/></label>
      <label>Exchange<select value={exchange} aria-label="Upstox exchange"
        onChange={e=>reset(setExchange)(e.target.value)}>
        {EXCHANGES.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
      <label>Segment<select value={segment} aria-label="Upstox segment"
        onChange={e=>reset(setSegment)(e.target.value)}>
        {SEGMENTS.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
      <label>Contract<select value={type} aria-label="Upstox contract type"
        onChange={e=>reset(setType)(e.target.value)}>
        {TYPES.map(x=><option key={x} value={x}>{x||'Any'}</option>)}</select></label>
      <label>Expiry<select value={expiry} aria-label="Upstox expiry"
        onChange={e=>reset(setExpiry)(e.target.value)}>
        {EXPIRIES.map(x=><option key={x} value={x}>
          {x?x.replace('_',' '):'Any'}</option>)}</select></label>
    </div>
    {query.trim().length<2
      ? <p className="terminal-footnote">Type at least two characters to start an authorized search.</p>
      : <p role="status" className="terminal-footnote">
          {loading?'Searching Upstox…':error||(
            result?result.instruments.length+' matching instruments · page '+result.page_number:
            'Enter a valid search') }</p>}
    {result&&<div className="qs-upstox-search-results" role="list" aria-label="Upstox search results">
      {result.instruments.map(item=><button type="button" role="listitem"
        className={'qs-upstox-instrument'+(selected?.instrument_key===item.instrument_key?' selected':'')}
        key={item.instrument_key} onClick={()=>setSelected(item)}>
        <strong>{item.trading_symbol||item.name||item.instrument_key}</strong>
        <span>{item.exchange} · {item.segment} · {item.instrument_type||'Instrument'}
          {item.expiry?' · '+item.expiry:''}</span>
      </button>)}
      {!result.instruments.length&&<p>No matching instruments in this page.</p>}
    </div>}
    {result&&<div className="qs-upstox-search-pagination">
      <button type="button" disabled={page<=1||loading} onClick={()=>setPage(n=>n-1)}>Previous</button>
      <span>Page {page} of {result.total_pages}</span>
      <button type="button" disabled={page>=result.total_pages||page>=100||loading}
        onClick={()=>setPage(n=>n+1)}>Next</button>
    </div>}
    {selected&&<div className="qs-upstox-instrument-detail" role="status">
      <strong>{selected.trading_symbol||selected.name}</strong>
      <span>Instrument key: <code>{selected.instrument_key}</code></span>
      <span>{selected.expiry?'Expiry '+selected.expiry+' · ':''}
        {selected.strike_price!==null?'Strike '+selected.strike_price+' · ':''}
        {selected.lot_size?'Lot '+selected.lot_size:''}</span>
      <p>Instrument identified. Historical candles and live subscriptions for this
        instrument require separate Rust adapter verification. No price or volume
        is inferred from instrument search.</p>
    </div>}
  </section>;
}

import React,{useEffect,useState} from 'react';
import {searchUpstoxInstruments} from './upstox-instrument-search.js';
import {browseMaster,masterStatus} from './upstox-master-catalog.js';
import {UpstoxInstrumentHistoryChart} from './upstox-instrument-history-chart.jsx';
import './upstox-instrument-search.css';

const EXCHANGES=['ALL','NSE','BSE','MCX'];
const SEGMENTS=['ALL','EQ','FO','INDEX','OPT','FUT','CURR','COMM'];
const TYPES=['','CE','PE','FUT','EQ','INDEX'];
const EXPIRIES=['','current_week','next_week','current_month','next_month'];
export function UpstoxInstrumentSearch(){
  const [mode,setMode]=useState('search');
  const [master,setMaster]=useState(null);
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
    if(mode!=='master')return;
    const controller=new AbortController();
    void masterStatus({signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted)setMaster(value);
    }).catch(()=>{if(!controller.signal.aborted)setMaster(null);});
    return()=>controller.abort();
  },[mode]);
  useEffect(()=>{
    const q=query.trim();
    if(mode==='search'&&q.length<2){
      setResult(null);setSelected(null);setError('');setLoading(false);return;
    }
    const controller=new AbortController();
    const timer=setTimeout(()=>{
      setLoading(true);setError('');
      const task=mode==='master'
        ?browseMaster({query:q,exchange,segment,type:type||'ALL',page},
          {signal:controller.signal})
        :searchUpstoxInstruments({query:q,exchange,segment,type,expiry,page},
          {signal:controller.signal});
      void task.then(value=>{
        if(!controller.signal.aborted){setResult(value);setSelected(null);}
      }).catch(e=>{
        if(!controller.signal.aborted){setResult(null);setSelected(null);
          setError(e?.message||'Instrument search unavailable');}
      }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    },350);
    return()=>{clearTimeout(timer);controller.abort();};
  },[mode,query,exchange,segment,type,expiry,page]);
  const reset=setter=>value=>{setter(value);setPage(1);setSelected(null);};
  return <section className="terminal-surface qs-upstox-instruments" aria-label="Upstox symbol search">
    <h2>Indian exchange instrument catalog</h2>
    <div className="qs-upstox-mode" role="group" aria-label="Instrument discovery mode">
      <button type="button" aria-pressed={mode==='search'}
        onClick={()=>{setMode('search');setQuery('');setPage(1);setSelected(null);setExchange('ALL');setSegment('ALL');setType('');}}>
        Search Upstox</button>
      <button type="button" aria-pressed={mode==='master'}
        onClick={()=>{setMode('master');setQuery('');setPage(1);setSelected(null);setExchange('NSE');setSegment('EQ');setType('');setExpiry('');}}>
        Full NSE/BSE master</button>
    </div>
    <p className="terminal-footnote">{mode==='master'
      ? 'Browse the imported Upstox BOD exchange lists: equities, indices, futures and options. Local files are updated only by an authorized operator, not automatically by browser requests.'
      : 'Discover Upstox symbols and individual futures/options contracts. Search results are not verified market prices.'}</p>
    {mode==='master'&&<p className="terminal-footnote" role="status">
      {master?.catalog_ready
        ? 'Imported '+master.imported_day_ist+' · NSE '+master.exchange_counts.NSE.toLocaleString()+
          ' instruments · BSE '+master.exchange_counts.BSE.toLocaleString()+
          ' instruments'+(master.imported_today_ist?'':' · refresh recommended')
        : 'Master list not yet imported. Ask an administrator to run the private BOD refresh.'}
    </p>}
    <div className="qs-upstox-search-filters">
      <label>Symbol, company or ISIN
        <input aria-label="Search Upstox symbols" type="search" autoComplete="off"
          maxLength={50} value={query} placeholder={mode==='master'?'All symbols or filter by name…':'NIFTY, RELIANCE, SENSEX…'}
          onChange={e=>reset(setQuery)(e.target.value)}/></label>
      <label>Exchange<select value={exchange} aria-label="Upstox exchange"
        onChange={e=>reset(setExchange)(e.target.value)}>
        {(mode==='master'?['NSE','BSE']:EXCHANGES).map(x=><option key={x} value={x}>{x}</option>)}</select></label>
      <label>Segment<select value={segment} aria-label="Upstox segment"
        onChange={e=>reset(setSegment)(e.target.value)}>
        {(mode==='master'?['ALL','EQ','INDEX','FO','CURR','COMM']:SEGMENTS).map(x=><option key={x} value={x}>{x}</option>)}</select></label>
      <label>Contract<select value={type} aria-label="Upstox contract type"
        onChange={e=>reset(setType)(e.target.value)}>
        {TYPES.map(x=><option key={x} value={x}>{x||'Any'}</option>)}</select></label>
      {mode==='search'&&<label>Expiry<select value={expiry} aria-label="Upstox expiry"
        onChange={e=>reset(setExpiry)(e.target.value)}>
        {EXPIRIES.map(x=><option key={x} value={x}>
          {x?x.replace('_',' '):'Any'}</option>)}</select></label>}
    </div>
    {mode==='search'&&query.trim().length<2
      ? <p className="terminal-footnote">Type at least two characters to start an authorized search.</p>
      : <p role="status" className="terminal-footnote">
          {loading?'Searching instruments…':error||(
            result?(mode==='master'?result.total_records+' total matches · ':'')+result.instruments.length+' displayed · page '+result.page_number:
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
      <p>This is a symbol-list entry, not a confirmed data subscription. Historical candles require the existing authenticated Rust feed and a short-lived signed selection. Live ticks remain unverified.</p>
      {selected.selection_scope
        ? <UpstoxInstrumentHistoryChart instrument={selected}/>
        : <p>Historical data unavailable for this instrument key.</p>}
    </div>}
  </section>;
}

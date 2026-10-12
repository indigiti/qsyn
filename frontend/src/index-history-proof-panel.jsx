import React,{useEffect,useState} from 'react';
import {Activity,RefreshCw} from 'lucide-react';

/** One bounded provider check, not a worker setup or a fake market-data feed. */
export function IndexHistoryProofPanel(){
  const [ready,setReady]=useState(null);
  const [date,setDate]=useState('');
  const [busy,setBusy]=useState('');
  const [results,setResults]=useState({});
  const [error,setError]=useState('');
  async function refresh(signal){
    try{
      const r=await fetch('/qsyn/api/v1/admin/upstox/index-history-proof',{
        credentials:'same-origin',cache:'no-store',signal,headers:{Accept:'application/json'}});
      const data=await r.json();
      if(!r.ok||data.schema!=='QSYN-INDEX-HISTORICAL-PROOF/1')throw Error(data.error||'HISTORY_PROOF_NOT_AVAILABLE');
      if(!signal?.aborted){
        setReady(data);
        setDate(old=>old||data.suggested_day_ist);
        setError('');
      }
    }catch(e){
      if(!signal?.aborted){
        setReady(null);
        setError(/^[a-z0-9_]{3,80}$/i.test(e.message||'')?e.message:'HISTORY_PROOF_UNAVAILABLE');
      }
    }
  }
  useEffect(()=>{
    const controller=new AbortController();
    void refresh(controller.signal);
    return ()=>controller.abort();
  },[]);
  async function probe(symbol){
    if(busy||!ready?.csrf||!ready?.token_present||!date)return;
    setBusy(symbol);setError('');
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch('/qsyn/api/v1/admin/upstox/index-history-proof',{
        method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
        headers:{'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':ready.csrf},
        body:JSON.stringify({confirmed:true,symbol,day:date})
      });
      const result=await response.json();
      if(!response.ok||result.schema!=='QSYN-INDEX-HISTORICAL-PROOF/1')
        throw Error(result.error||'HISTORY_PROOF_FAILED');
      if(result.symbol!==symbol||result.day_ist!==date||
        typeof result.candle_count!=='number'||typeof result.history_verified!=='boolean')
        throw Error('HISTORY_PROOF_INVALID_RESPONSE');
      setResults(s=>({...s,[symbol]:result}));
    }catch(e){
      setError(controller.signal.aborted?'HISTORY_PROOF_TIMEOUT':
        /^[a-z0-9_]{3,80}$/i.test(e.message||'')?e.message:'HISTORY_PROOF_NETWORK_ERROR');
    }finally{
      clearTimeout(timeout);
      setBusy('');
    }
  }
  return <section className="qt-index-proof" aria-label="Verify real Upstox historical index candles">
    <div className="qt-provider-header">
      <div><h3>First prove the data source</h3><p className="terminal-footnote">
        Ask Upstox directly for actual 1-minute historical candles before enabling any worker.</p></div>
      <Activity size={20} aria-hidden="true"/>
    </div>
    <div className="qt-index-proof-actions">
      <label>Completed trading date (IST)
        <input type="date" value={date} onChange={event=>{
          setDate(event.target.value);setResults({});
        }}/></label>
      {['NIFTY','SENSEX'].map(symbol=><button type="button" key={symbol}
        className="terminal-action terminal-secondary-action"
        disabled={!!busy||!ready?.token_present||!date}
        onClick={()=>void probe(symbol)}>
        <RefreshCw size={14}/> {busy===symbol?'Checking…':'Test '+symbol}
      </button>)}
    </div>
    {ready&&!ready.token_present&&<p role="status" className="qt-message">
      A stored, account-bound read-only Analytics Token is required. Use the
      Upstox token form below; no server console or Rust worker is required for this proof.</p>}
    {error&&<p role="alert" className="qt-message">{error}</p>}
    {Object.entries(results).map(([symbol,result])=><div className="qt-index-proof-result"
      key={symbol} role="status">
      <strong>{symbol}: {result.code}</strong>
      <small>Provider HTTP {result.provider_http_status} · {result.candle_count}
        {' '}verified candles</small>
      {result.first_candle_utc&&<small>First: {result.first_candle_utc}</small>}
      {result.last_candle_utc&&<small>Last: {result.last_candle_utc}</small>}
    </div>)}
    <p className="terminal-footnote">Read-only proof returns only a candle count and
      exchange data timestamps. It does not expose prices, grant NSE/BSE
      display rights, activate streaming or route orders. An HTTP 200 with zero
      candles is not a successful data verification.</p>
  </section>;
}

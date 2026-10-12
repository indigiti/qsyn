import React,{useEffect,useState,useCallback} from 'react';
import {Activity,RefreshCw} from 'lucide-react';
import {MARKET_PROVIDERS,PUBLIC_CRYPTO,isValidCryptoHealth} from './market-model.js';
import './market-explorer.css';

/** Read-only operator view. Each provider is checked separately and success
 * means only that its public health API responded with the expected contract.
 * Never present bearer-file presence as exchange rights or active streaming.
 */
export function ProviderStatusPanel(){
  const [reports,setReports]=useState({}),[checked,setChecked]=useState(null);
  const [busy,setBusy]=useState(false),[generation,setGeneration]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setBusy(true);
    void Promise.all(MARKET_PROVIDERS.map(async provider=>{
      if(provider.adapter==='simulated_options')
        return [provider.id,{code:'SIMULATION_ONLY',status:'simulated'}];
      if(provider.adapter==='private_upstox'){
        try{
          const res=await fetch('/qsyn/api/v1/admin/upstox/analytics/status',{
            credentials:'same-origin',cache:'no-store',signal:controller.signal,
            headers:{Accept:'application/json'}});
          const data=res.ok?await res.json():null;
          // Personal market data depends only on the stored read-only
          // Analytics Token. Index worker/supervisor plans are unrelated.
          const code=data?.schema==='QSYN-UPSTOX-ANALYTICS-STATUS/1'
            ? (data.token_stored===true
              ? 'ANALYTICS_TOKEN_STORED':'ANALYTICS_TOKEN_REQUIRED')
            : 'ANALYTICS_STATUS_UNAVAILABLE';
          return [provider.id,{code,status:'not_verified'}];
        }catch{return [provider.id,{code:'ADMIN_STATUS_UNAVAILABLE',status:'not_verified'}];}
      }
      const venue=provider.venues[0];
      const instrument=PUBLIC_CRYPTO.find(x=>x.exchange===venue);
      if(!instrument)return [provider.id,{code:'NO_REFERENCE_INSTRUMENT',status:'not_verified'}];
      const q=new URLSearchParams({exchange:venue,market:instrument.market,
        symbol:instrument.symbol,interval:'1m',limit:'5'});
      try{
        const res=await fetch('/qsyn/api/v1/crypto/health?'+q,{
          credentials:'same-origin',cache:'no-store',signal:controller.signal,
          headers:{Accept:'application/json'}});
        const data=res.ok?await res.json():null;
        return [provider.id,{code:isValidCryptoHealth(data,venue)
          ?'HEALTH_API_RESPONDING':'HEALTH_NOT_VERIFIED',
          status:isValidCryptoHealth(data,venue)?'responding':'not_verified'}];
      }catch{return [provider.id,{code:'HEALTH_API_UNAVAILABLE',status:'not_verified'}];}
    })).then(rows=>{
      if(!controller.signal.aborted){setReports(Object.fromEntries(rows));setChecked(new Date().toISOString());}
    }).finally(()=>{if(!controller.signal.aborted)setBusy(false)});
    return ()=>controller.abort();
  },[generation]);
  return <section className="qt-provider-status" aria-label="Market-data provider status">
    <div className="qt-provider-header">
      <div><h3>Available data sources</h3><p className="terminal-footnote">
        Use public crypto APIs or your private Upstox Analytics Token for personal indices.</p></div>
      <button type="button" className="terminal-action terminal-secondary-action"
        disabled={busy} onClick={()=>setGeneration(x=>x+1)}>
        <RefreshCw size={15}/>{busy?' Checking…':' Recheck'}</button>
    </div>
    <div className="qt-provider-cards">
      {MARKET_PROVIDERS.map(p=>{
        const code=reports[p.id]?.code||'NOT_CHECKED';
        const live=code==='HEALTH_API_RESPONDING';
        return <article className="qt-provider-tile" key={p.id}>
          <div className="qt-provider-logo" aria-hidden="true">{p.label.slice(0,2).toUpperCase()}</div>
          <div className="qt-provider-tile-body">
            <strong>{p.label}</strong>
            <small>{p.asset_classes.join(' · ')}</small>
            <span className={'qt-provider-evidence'+(live?' responding':'')}>
              <span className="qt-status-dot" aria-hidden="true"/>{live?'API responding':code.replaceAll('_',' ').toLowerCase()}
            </span>
          </div>
        </article>;
      })}
    </div>
    <details className="qt-provider-details">
      <summary>Technical source evidence</summary>
      <p className="terminal-footnote">API response is not proof of streaming market candles,
        NSE/BSE display rights, account identity or order execution.</p>
      <div className="qt-table-wrap"><table className="qt-table">
        <thead><tr><th>Provider</th><th>Status code</th></tr></thead>
        <tbody>{MARKET_PROVIDERS.map(p=><tr key={p.id}>
          <td>{p.label}</td><td>{reports[p.id]?.code||'NOT_CHECKED'}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
    <p className="terminal-footnote">Checked: {checked||'not yet checked'}.
      No broker credentials or prices are included in this report.</p>
  </section>;
}

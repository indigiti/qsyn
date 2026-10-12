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
          return [provider.id,{
            code:data?.schema==='QSYN-UPSTOX-ANALYTICS-STATUS/1' &&
              data.token_stored===true?'TOKEN_STORED_NOT_LIVE':'FEED_NOT_VERIFIED',
            status:'not_verified'
          }];
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
  return <section className="terminal-surface qt-provider-status" aria-label="Market-data provider status">
    <div className="terminal-card-head"><h2>Data provider registry · live checks</h2>
      <button type="button" className="terminal-action terminal-secondary-action"
        disabled={busy} onClick={()=>setGeneration(x=>x+1)}>
        <RefreshCw size={15}/>{busy?' Checking…':' Recheck'}</button></div>
    <p className="terminal-footnote">These checks identify a responding public venue
      or privately stored credential. They do not certify continuously streaming
      candles, licensed Indian display rights, account identity or execution.</p>
    <div className="qt-table-wrap"><table className="qt-table">
      <thead><tr><th>Provider</th><th>Market(s)</th><th>Evidence</th></tr></thead>
      <tbody>{MARKET_PROVIDERS.map(p=><tr key={p.id}>
        <td><strong>{p.label}</strong></td>
        <td>{p.asset_classes.join(', ')}</td>
        <td>{reports[p.id]?.code||'NOT_CHECKED'}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="terminal-footnote">Checked: {checked||'not yet checked'} ·
      Run Diagnostics for full source/transport evidence. No broker token is returned.</p>
  </section>;
}

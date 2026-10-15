import React, {useEffect,useState,useCallback} from 'react';
import {Activity,AlertTriangle,CheckCircle2,ClipboardCopy,LockKeyhole,RefreshCw,Search,Server,ShieldCheck,Wallet,Wifi,WifiOff} from 'lucide-react';
import {CRYPTO_MARKETS} from './crypto-catalog.js';
import {INDIA_INDEX_MARKETS} from './india-index-catalog.js';
import {ProviderStatusPanel} from './provider-console.jsx';
import {IndexHistoryProofPanel} from './index-history-proof-panel.jsx';
import './terminal-unified.css';

const VENUES=['BINANCE','BYBIT','OKX','COINBASE','KRAKEN','BITGET','HYPERLIQUID'];
const FRESH=Object.freeze(Object.fromEntries(VENUES.map(exchange=>{
  const x=CRYPTO_MARKETS.find(row=>row.exchange===exchange);
  return [exchange,{exchange:x.exchange,market:x.market,symbol:x.symbol}];
})));
const ADMIN_API='/qsyn/api/v1/admin/rust/';
async function jsonGet(path,signal) {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',
    signal,headers:{Accept:'application/json'}});
  const data=await response.json();
  if(!response.ok) throw Error(data.error||'endpoint_unavailable');
  return data;
}
async function adminPost(operation,payload,csrf) {
  const r=await fetch(ADMIN_API+operation,{method:'POST',credentials:'same-origin',
    cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json',
      ...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(payload)});
  const data=await r.json();
  if(!r.ok)throw Error(data.error||'admin_operation_denied');
  return data;
}
function Result({ok,children}){
  return <span className={'qt-health-badge '+(ok?'good':'bad')}>
    {ok?<CheckCircle2 size={14}/>:<AlertTriangle size={14}/>} {children}
  </span>;
}
function PanelTitle({eyebrow,title,description,children}) {
  return <header className="terminal-title"><div>
    <p className="terminal-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p>
    </div>{children}</header>;
}
export function DiagnosticsWorkspace(){
  const [rows,setRows]=useState({});
  const [rust,setRust]=useState(null);
  const [india,setIndia]=useState(null);
  const [busy,setBusy]=useState(false);
  const [sample,setSample]=useState(null);
  const [last,setLast]=useState(0);
  const [adminAudit,setAdminAudit]=useState(null),[auditError,setAuditError]=useState('');
  const [auditLoading,setAuditLoading]=useState(false);
  const [ownerGrantMessage,setOwnerGrantMessage]=useState('');
  const [ownerGrantBusy,setOwnerGrantBusy]=useState(false);
  const probe=useCallback(async(signal)=>{
    setBusy(true);
    const values=await Promise.all(VENUES.map(async ex=>{
      const item=FRESH[ex];
      const p=new URLSearchParams({...item,interval:'1m',limit:'5'});
      try {
        const r=await jsonGet('/qsyn/api/v1/crypto/health?'+p,signal);
        if(r.schema!=='QSYN-PUBLIC-CRYPTO-HEALTH/1'||r.exchange!==ex||
            r.source!=='exchange_public'||r.trading_enabled!==false)throw Error('invalid_source_contract');
        return [ex,{feed:r.feed,instrument:item.symbol}];
      }catch(e){return [ex,{error:signal.aborted?'cancelled':String(e.message).slice(0,80)}];}
    }));
    if(signal.aborted)return;
    setRows(Object.fromEntries(values));
    const [service,indexes]=await Promise.all([
      jsonGet('/qsyn/api/v1/diagnostics/rust',signal).catch(()=>null),
      jsonGet('/qsyn/api/v1/india/indexes',signal).catch(()=>null),
    ]);
    if(signal.aborted)return;
    setRust(service);setIndia(indexes);setLast(Date.now());setBusy(false);
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    void probe(controller.signal);
    const timer=setInterval(()=>{if(!controller.signal.aborted)void probe(controller.signal);},20000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[probe]);
  const exportReport=()=> {
    const safe={schema:'QSYN-TERMINAL-HEALTH-SNAPSHOT/1',checked_at_ms:last,
      public_venues:rows,rust_status:rust?.status||'unavailable',
      india_catalog_ready:india?.schema==='QSYN-INDIA-INDEX-CATALOG/1',
      trading_enabled:false};
    void navigator.clipboard?.writeText(JSON.stringify(safe,null,2));
  };
  async function runAdminAudit(){
    setAuditLoading(true);setAuditError('');
    const started=Date.now();const ctl=new AbortController();
    const timeout=setTimeout(()=>ctl.abort(),12000);
    try{
      const res=await fetch('/qsyn/api/v1/admin/diagnostics/report',{
        credentials:'same-origin',cache:'no-store',signal:ctl.signal,
        headers:{Accept:'application/json'}});
      const data=await res.json();
      if(!res.ok){
        setAdminAudit(null);
        setAuditError(res.status===401?'ADMIN_REAUTH_REQUIRED':
          res.status===503?'DIAGNOSTICS_SERVICE_UNAVAILABLE':'DIAGNOSTICS_HTTP_'+res.status);
        return;
      }
      if(data.schema!=='QSYN-ADMIN-DIAGNOSTICS/1')throw Error('INVALID_REPORT_SCHEMA');
      setAdminAudit({...data,browser:{
        schema:'QSYN-CLIENT-DIAGNOSTIC/1',
        checked_at_utc:new Date().toISOString(),
        request_duration_ms:Date.now()-started,
        client_http_status:res.status,
        source:'admin_terminal',
      }});
    }catch{
      setAdminAudit(null);
      setAuditError(ctl.signal.aborted?'DIAGNOSTICS_REQUEST_TIMEOUT':'DIAGNOSTICS_NETWORK_ERROR');
    }finally{clearTimeout(timeout);setAuditLoading(false);}
  }
  async function authorizeOwnerBrowser(){
    setOwnerGrantBusy(true);setOwnerGrantMessage('');
    try{
      const path='/qsyn/api/v1/owner-index/browser-grant';
      const context=await jsonGet(path);
      if(context.schema!=='QSYN-OWNER-BROWSER-GRANT/1'||context.grant_ready!==true
        ||!/^[a-f0-9]{64}$/.test(context.csrf))
        throw Error('OWNER_BROWSER_GRANT_NOT_PROVISIONED');
      const response=await fetch(path,{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Accept':'application/json','X-CSRF-Token':context.csrf}
      });
      const data=await response.json();
      if(!response.ok||data.schema!=='QSYN-OWNER-BROWSER-GRANT/1'
        ||data.browser_authorized!==true)throw Error(data.error||'OWNER_BROWSER_GRANT_FAILED');
      setOwnerGrantMessage('This browser is authorized for read-only index charts through '+data.expires_at_utc+'. Open the homepage to view indices.');
    }catch(error){setOwnerGrantMessage(String(error.message||'OWNER_BROWSER_GRANT_FAILED'));}
    finally{setOwnerGrantBusy(false);}
  }
  async function sampleDemo() {
    setSample({message:'Checking demo stream…'});
    try {
      const data=await jsonGet('/qsyn/api/v1/diagnostics/rust-stream');
      setSample({message:data.status==='streaming'
        ?'Read-only simulated Rust samples received; not an exchange market feed.'
        : 'Demo stream: '+String(data.status||'unavailable')});
    }catch(e){setSample({message:'Demo stream unavailable: '+e.message});}
  }
  return <div className="terminal-page qt-unified">
    <PanelTitle eyebrow="OBSERVABILITY · READ ONLY" title="Diagnostics & feed health"
      description="Seven public exchange workers, Rust status and India market-data readiness inside one terminal.">
      <div className="qt-actions">
        <button className="terminal-action terminal-secondary-action" disabled={busy}
          onClick={()=>void probe(new AbortController().signal)}><RefreshCw size={16}/> Refresh</button>
        <button className="terminal-action terminal-secondary-action" disabled={!last} onClick={exportReport}>
          <ClipboardCopy size={16}/> Copy report</button>
      </div>
    </PanelTitle>
    <section className="terminal-surface" aria-label="Administrator diagnostics center">
      <div className="terminal-card-head"><h2>Administrator diagnostics center</h2><ShieldCheck size={18}/></div>
      <p>Read-only audit of session state, private Upstox configuration and Rust index
        worker packaging. This does not use tokens to contact Upstox, start a feed or place orders.</p>
      <div className="qt-actions">
        <button type="button" className="terminal-action" disabled={auditLoading}
          onClick={()=>void runAdminAudit()}><RefreshCw size={15}/>
          {auditLoading?' Checking…':'Run secure audit'}</button>
        <button type="button" className="terminal-action terminal-secondary-action"
          disabled={ownerGrantBusy} onClick={()=>void authorizeOwnerBrowser()}>
          <ShieldCheck size={15}/>{ownerGrantBusy?' Authorizing…':' Authorize this browser for index charts'}</button>
        <button type="button" className="terminal-action terminal-secondary-action"
          disabled={!adminAudit}
          onClick={()=>void navigator.clipboard?.writeText(JSON.stringify(adminAudit,null,2))}>
          <ClipboardCopy size={15}/> Copy diagnostic JSON</button>
      </div>
      {ownerGrantMessage&&<p role="status">{ownerGrantMessage}</p>}
      {auditError&&<p role="alert">Diagnostic check: {auditError}.
        The admin login or server connectivity may need attention.</p>}
      {adminAudit&&<div>
        <p role="status">Checked {adminAudit.checked_at_utc} · Request ID {adminAudit.request_id}</p>
        <div className="qt-table-wrap"><table className="qt-table">
          <thead><tr><th>Component</th><th>Reported state</th><th>Code</th></tr></thead>
          <tbody>{(adminAudit.components||[]).map(c=><tr key={c.component}>
            <td>{c.component}</td><td>{c.status}</td><td><code>{c.code}</code></td>
          </tr>)}</tbody>
        </table></div>
        <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>
          {JSON.stringify(adminAudit,null,2)}</pre>
        <p className="terminal-footnote">No broker credentials, access tokens, administrator
          password, session cookie values or private paths are included.</p>
      </div>}
    </section>
    <div className="qt-summary">
      <section className="terminal-surface"><Activity size={19}/><span>Public crypto venues</span>
        <strong>{VENUES.filter(x=>rows[x]?.feed?.state==='websocket'&&rows[x]?.feed?.fresh===true).length} / 7 fresh</strong></section>
      <section className="terminal-surface"><Server size={19}/><span>Rust engine</span>
        <strong>{rust?.status==='online'?'Online':rust?.status==='offline'?'Offline':'Unverified'}</strong></section>
      <section className="terminal-surface"><LockKeyhole size={19}/><span>India index prices</span>
        <strong>Authorization required</strong></section>
    </div>
    <section className="terminal-surface">
      <div className="terminal-card-head"><h2>Exchange WebSocket workers</h2>
        <small>{last?'Checked '+new Date(last).toLocaleTimeString():'Checking…'} · 20s monitoring</small>
      </div>
      <div className="qt-table-wrap"><table className="qt-table">
        <thead><tr><th>Exchange / instrument</th><th>Transport</th><th>Lag</th><th>History</th><th>Reconnects</th></tr></thead>
        <tbody>{VENUES.map(x=>{
          const f=rows[x]?.feed;
          const ok=f?.state==='websocket'&&f?.fresh===true;
          return <tr key={x}><td><strong>{x}</strong><small>{rows[x]?.instrument||FRESH[x].symbol}</small></td>
            <td><Result ok={ok}>{f?.state||rows[x]?.error||'Checking'}</Result></td>
            <td>{typeof f?.websocket_lag_seconds==='number'?f.websocket_lag_seconds+'s':'—'}</td>
            <td>{typeof f?.missing_history_bars==='number'?f.missing_history_bars+' missing':'—'}</td>
            <td>{Number.isInteger(f?.reconnect_count)?f.reconnect_count:'—'}</td></tr>;
        })}</tbody>
      </table></div>
      <p className="terminal-footnote">A fresh WebSocket does not guarantee uninterrupted history. Coinbase intermittent missing candles remain observable. No synthetic candles are substituted.</p>
    </section>
    <div className="qt-two">
      <section className="terminal-surface">
        <div className="terminal-card-head"><h2>Rust service</h2><Wifi size={17}/></div>
        <p role="status">HTTP: {rust?.http||'unverified'} · WebSocket: {rust?.websocket||'unverified'}</p>
        <p className="terminal-footnote">This view cannot start or stop a service. Protected controls are in Operations.</p>
        <button type="button" className="terminal-action terminal-secondary-action" onClick={()=>void sampleDemo()}>Test read-only demo stream</button>
        {sample&&<p role="status" className="terminal-footnote">{sample.message}</p>}
      </section>
      <section className="terminal-surface">
        <div className="terminal-card-head"><h2>India market coverage</h2><ShieldCheck size={17}/></div>
        <p>{india?.indexes?.length===6?'Six index aliases registered':'Catalog unavailable'} · NSE/BSE feed not yet licensed</p>
        <p className="terminal-footnote">Upstox OAuth, verified instrument master and market-data display rights are separate requirements. No index prices are publicly redistributed.</p>
      </section>
    </div>
  </div>;
}
const NATIVE_UPSTOX_API='/qsyn/api/v1/admin/upstox/';
function NativeUpstoxPanel({refreshTick=0}){
  const [status,setStatus]=useState(null),[busy,setBusy]=useState(false);
  const [profileCheck,setProfileCheck]=useState(null);
  const [indexDiscovery,setIndexDiscovery]=useState(null);
  const [lastDiagnostic,setLastDiagnostic]=useState(null);
  const [notice,setNotice]=useState('Checking native Upstox authorization readiness…');
  const [form,setForm]=useState({client_id:'',client_secret:'',expected_user_id:'',confirmed:false});
  const [analytics,setAnalytics]=useState(null);
  const [analyticsError,setAnalyticsError]=useState(null);
  const [analyticsVerification,setAnalyticsVerification]=useState(null);
  const [analyticsToken,setAnalyticsToken]=useState('');
  const [analyticsConfirmed,setAnalyticsConfirmed]=useState(false);
  const load=useCallback(async()=>{
    try{
      const data=await jsonGet(NATIVE_UPSTOX_API+'status');
      if(data.schema!=='QSYN-NATIVE-UPSTOX-WEB/1')throw Error('unexpected_schema');
      setStatus(data);
      setProfileCheck(null);
      setIndexDiscovery(null);
      setNotice(data.token_stored
        ?'A provider-identity-checked Upstox token is stored privately. Current validity, index display rights and live feed remain unverified.'
        :data.configured?'Upstox app configured. Authorize using your Upstox login.':'Set up your Upstox Developer App before authorizing.');
    }catch{setStatus(null);setNotice('Native Upstox setup is unavailable; check the QSYN administrator session and private runtime.');}
  },[]);
  const loadAnalytics=useCallback(async()=>{
    try{
      const response=await fetch(NATIVE_UPSTOX_API+'analytics/status',{
        method:'GET',credentials:'same-origin',cache:'no-store',
        headers:{Accept:'application/json'},
      });
      const data=await response.json();
      const loaded=response.ok && data.schema==='QSYN-UPSTOX-ANALYTICS-STATUS/1'
        ? data : null;
      setAnalytics(loaded);
      setAnalyticsError(loaded?null:
        data?.error==='analytics_account_binding_unavailable'
          ? 'UPSTOX_ANALYTICS_BIND_EXPECTED_USER_REQUIRED'
          : data?.error==='analytics_token_import_disabled'
          ? 'ANALYTICS_EXPLICITLY_DISABLED'
          : response.status===401
          ? 'QSYN_ADMIN_LOGIN_REQUIRED'
          : 'ANALYTICS_SETUP_UNAVAILABLE');
    }catch{
      setAnalytics(null);
      setAnalyticsError('ANALYTICS_STATUS_NETWORK_ERROR');
    }
  },[]);
  useEffect(()=>{void load();void loadAnalytics();},[load,loadAnalytics,refreshTick]);

  async function analyticsAction(operation){
    if(!analytics?.csrf || busy)return;
    if(operation==='import' && (!analyticsConfirmed || analyticsToken.length<20))return;
    const token=analyticsToken;
    setAnalyticsToken('');
    setAnalyticsConfirmed(false);
    setAnalyticsVerification(null);
    setBusy(true);
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),20000);
    try{
      setNotice(operation==='import'
        ? 'Verifying read-only market WebSocket authorization with Upstox…'
        : operation==='verify'
        ? 'Checking existing private Analytics Token with the read-only Upstox feed API…'
        : 'Removing the locally stored Analytics Token (Upstox revocation remains separate)…');
      const response=await fetch(NATIVE_UPSTOX_API+'analytics/'+operation,{
        method:'POST',credentials:'same-origin',cache:'no-store',
        signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json',
          'X-CSRF-Token':analytics.csrf},
        body:JSON.stringify(operation==='import'
          ? {token,confirmed:true} : {confirmed:true}),
      });
      const data=await response.json();
      if(!response.ok)throw Error(
        /^[a-z0-9_]{3,80}$/.test(data?.error||'')
          ? data.error.toUpperCase() : 'ANALYTICS_REQUEST_DENIED');
      if(data.schema!=='QSYN-UPSTOX-ANALYTICS-STATUS/1')
        throw Error('INVALID_ANALYTICS_RESPONSE');
      if(operation==='verify'){
        if(typeof data.provider_feed_authorized_now!=='boolean' ||
            !/^UPSTOX_ANALYTICS_MARKET_(?:AUTHORIZED_NOW|AUTH_UNAVAILABLE)$/.test(data.diagnostic_code||''))
          throw Error('INVALID_ANALYTICS_VERIFICATION');
        setAnalyticsVerification({verified:data.provider_feed_authorized_now,
          checked_at_utc:data.checked_at_utc,code:data.diagnostic_code});
      }
      setNotice(operation==='import'
        ? 'Read-only market-feed authorization verified at import and token stored privately. Actual account identity, index rights, historical data and live charts still require independent verification.'
        : operation==='verify'
        ? data.provider_feed_authorized_now
          ? 'Analytics Token accepted by Upstox market-feed authorize now. Account identity, index rights, Rust worker and live prices are still unverified.'
          : 'Stored token was rejected or the provider is unavailable. No index feed started. Check the sanitized diagnostic code.'
        : 'Local Analytics Token removed. If necessary, revoke it in the Upstox Developer Apps dashboard.');
      await loadAnalytics();
    }catch(err){
      const code=controller.signal.aborted?'ANALYTICS_REQUEST_TIMEOUT':
        /^[A-Z0-9_]{3,80}$/.test(err?.message||'')?err.message:
        'ANALYTICS_NETWORK_OR_RESPONSE_ERROR';
      setNotice('Analytics Token not activated: '+code+
        '. Do not share the token or browser request bodies.');
    }finally{
      clearTimeout(timeout);
      setBusy(false);
    }
  }
  async function action(operation,payload){
    if(!status?.csrf||busy)return;
    setBusy(true);
    const started=Date.now();
    const ctl=new AbortController();
    const timeout=setTimeout(()=>ctl.abort(),operation==='discover'?45000:15000);
    let httpStatus=0,requestId=null;
    try{
      setNotice(operation==='discover'?'Checking the current Upstox index instrument catalog…'
        :operation==='verify'
        ?'Contacting the official Upstox profile API…'
        :operation==='begin'?'Preparing secure Upstox authorization…':'Saving the Upstox app privately…');
      const r=await fetch(NATIVE_UPSTOX_API+operation,{
        method:'POST',credentials:'same-origin',cache:'no-store',signal:ctl.signal,
        headers:{'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':status.csrf},
        body:JSON.stringify(payload)});
      httpStatus=r.status;
      const id=r.headers.get('X-QSYN-Request-ID');
      requestId=/^[a-f0-9]{16}$/.test(id||'')?id:null;
      let data;
      try{data=await r.json();}catch{throw Error('INVALID_JSON_RESPONSE');}
      if(!r.ok)throw Error(/^[a-z0-9_]{3,80}$/.test(data.error||'')
        ?data.error.toUpperCase():'HTTP_REQUEST_REJECTED');
      if(operation==='setup'){
        setForm({client_id:'',client_secret:'',expected_user_id:'',confirmed:false});
        await load();
        setNotice('Upstox app configuration saved. Register its callback before OAuth.');
      }else if(operation==='verify'){
        setProfileCheck(data);
        const code=/^[A-Z0-9_]{8,80}$/.test(data.diagnostic_code||'')
          ?data.diagnostic_code:'UPSTOX_UNCLASSIFIED_STATUS';
        setLastDiagnostic({schema:'QSYN-UPSTOX-BROWSER-DIAGNOSTIC/1',
          checked_at_utc:new Date().toISOString(),component:'native_upstox_profile',
          operation:'verify',http_status:r.status,request_id:requestId,
          duration_ms:Date.now()-started,code,session_verified:data.session_verified===true,
          index_feed_activated:false,trading_enabled:false});
        setNotice(data.session_verified
          ?'Upstox profile verified at this instant. Index feeds, licensing and chart subscriptions remain independently gated.'
          :'Upstox verification failed: '+code+'. Copy the JSON report below for diagnosis.');
      }else if(operation==='discover'){
        if(data.schema!=='QSYN-UPSTOX-INDEX-DISCOVERY/1')
          throw Error('INVALID_INDEX_DISCOVERY_SCHEMA');
        setIndexDiscovery(data);
        setLastDiagnostic({schema:'QSYN-UPSTOX-BROWSER-DIAGNOSTIC/1',
          checked_at_utc:new Date().toISOString(),component:'native_upstox_index_instruments',
          operation:'discover',http_status:r.status,request_id:requestId,
          duration_ms:Date.now()-started,code:data.code||'UPSTOX_INDEX_SEARCH_UNAVAILABLE',
          session_verified:data.session_verified_now===true,
          index_feed_activated:false,trading_enabled:false});
        setNotice(data.mapping_fully_resolved
          ?'Six Upstox index instrument keys found for review. This is NOT a current BOD attestation, market-data license or live stream.'
          :'Instrument lookup incomplete: '+(data.code||'UPSTOX_INDEX_SEARCH_UNAVAILABLE')+
           '. Inspect the instrument table and copy the safe report.');
      }else if(operation==='begin'){
        const url=new URL(data.authorization_url);
        if(url.protocol!=='https:'||url.hostname!=='api.upstox.com'
          ||url.pathname!=='/v2/login/authorization/dialog'
          ||url.searchParams.get('response_type')!=='code'
          ||!url.searchParams.get('state'))throw Error('INVALID_UPSTOX_AUTHORIZE_URL');
        window.location.assign(url.href);
      }
    }catch(err){
      const code=ctl.signal.aborted?'CLIENT_REQUEST_TIMEOUT'
        :/^[A-Z0-9_]{3,80}$/.test(err?.message||'')?err.message
        :'CLIENT_NETWORK_OR_RESPONSE_ERROR';
      setLastDiagnostic({schema:'QSYN-UPSTOX-BROWSER-DIAGNOSTIC/1',
        checked_at_utc:new Date().toISOString(),component:'native_upstox_profile',
        operation,http_status:httpStatus,request_id:requestId,
        duration_ms:Date.now()-started,code,session_verified:false,
        index_feed_activated:false,trading_enabled:false});
      setNotice('Upstox request not completed: '+code+
        '. You can copy the sanitized JSON below. Do not share credentials.');
    }finally{clearTimeout(timeout);setBusy(false);}
  }
  return <div className="qt-openalgo-setup">
    <p role="status" className="qt-message" style={{fontWeight:600}}>{busy?'Working · ':''}{notice}</p>
    {lastDiagnostic&&<section aria-label="Upstox error diagnostics" className="terminal-surface">
      <div className="terminal-card-head"><h3>Upstox diagnostic report</h3>
        <button type="button" className="terminal-action terminal-secondary-action"
          onClick={()=>void navigator.clipboard?.writeText(JSON.stringify(lastDiagnostic,null,2))}>
          <ClipboardCopy size={15}/> Copy safe JSON</button></div>
      <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>
        {JSON.stringify(lastDiagnostic,null,2)}</pre>
      <p className="terminal-footnote">Report contains only approved status codes and timing;
        never paste Upstox tokens, OAuth codes, cookies or passwords into support messages.</p>
    </section>}
    <div className="qt-summary">
      <div><strong>Upstox personal market data</strong><p>{analytics?.token_stored
        ? 'Analytics Token stored · read-only historical and 1m OHLC available'
        : 'Store your one-year Analytics Token below'}</p></div>
      <div><strong>QSYN trading</strong><p>Disabled · no OAuth required for market-data charts</p></div>
    </div>
    <section className="terminal-surface" aria-label="Upstox Analytics Token setup">
      <div className="terminal-card-head"><h3>Upstox Analytics Token · read-only</h3><ShieldCheck size={17}/></div>
      <p>Generate your 1-year read-only
        token in Upstox Developer Apps → Analytics. QSYN verifies its market-data
        authorization and stores it in a private 0600 file. QSYN's personal
        charts use this same token for historical candles and current-day
        Upstox 1-minute OHLC quotes. No OAuth login, private index plan,
        worker Supervisor or additional approval wizard is involved.</p>
      {analytics ? <>
        <p role="status">{analytics.token_stored
          ? 'Analytics Token stored securely. Personal chart data is ready; live updates require fresh provider OHLC during trading hours.'
          : 'No Analytics Token stored. Import your Upstox Analytics Token to start.'}</p>
        <form className="qt-form qt-openalgo-setup" autoComplete="off"
          onSubmit={e=>{e.preventDefault();void analyticsAction('import');}}>
          <label>Analytics Token (not app API secret)
            <input type="password" required minLength={20} maxLength={8192}
              autoComplete="new-password" spellCheck={false}
              value={analyticsToken} onChange={e=>setAnalyticsToken(e.target.value)}/>
          </label>
          <label className="qt-setup-confirm">
            <input type="checkbox" checked={analyticsConfirmed}
              onChange={e=>setAnalyticsConfirmed(e.target.checked)}/>
            This is my own read-only Upstox Analytics Token. I understand that
            token verification does not approve exchange redistribution, retention
            or production feed activation.
          </label>
          {analyticsVerification&&<p role="status">Stored-token check:
            {' '}{analyticsVerification.verified?'Market-data authorization verified at check time':'Authorization unavailable'}
            {' · '}{analyticsVerification.code}</p>}
          <div className="qt-actions">
            <button className="terminal-action" type="submit"
              disabled={busy||!analyticsConfirmed||analyticsToken.length<20}>
              Verify and store Analytics Token</button>
            <button className="terminal-action terminal-secondary-action" type="button"
              disabled={busy||!analytics.token_stored}
              onClick={()=>void analyticsAction('verify')}>Verify stored token</button>
            <button className="terminal-action terminal-secondary-action" type="button"
              disabled={busy||!analytics.token_stored}
              onClick={()=>void analyticsAction('clear')}>Remove local token</button>
          </div>
        </form>
      </>:<p role="status">Analytics Token setup not ready ·
        {' '}{analyticsError||'ANALYTICS_SETUP_UNAVAILABLE'}.
        {analyticsError==='UPSTOX_ANALYTICS_BIND_EXPECTED_USER_REQUIRED'
          ? ' Configure an expected Upstox User ID through the existing private Upstox app setup or server account binding.'
          : analyticsError==='ANALYTICS_EXPLICITLY_DISABLED'
          ? ' The server operator explicitly disabled Analytics Token import.'
          : ' Check administrator access and the private runtime.'}
        {' '}Do not share tokens in chat.</p>}
    </section>
    <div className="qt-actions">
      <button type="button" className="terminal-action terminal-secondary-action"
        disabled={busy||!analytics?.token_stored}
        onClick={()=>void action('discover',{})}>
        <Search size={16}/> Discover available indices
      </button>
    </div>
    {indexDiscovery&&<section className="terminal-surface" aria-label="Upstox index instrument lookup">
      <div className="terminal-card-head"><h3>Upstox NSE/BSE index lookup</h3>
        <button type="button" className="terminal-action terminal-secondary-action"
          onClick={()=>void navigator.clipboard?.writeText(JSON.stringify(indexDiscovery,null,2))}>
          <ClipboardCopy size={15}/> Copy mapping JSON</button>
      </div>
      <p role="status">Lookup: {indexDiscovery.status} · {indexDiscovery.code}</p>
      <div className="qt-table-wrap"><table className="qt-table">
        <thead><tr><th>QSYN index</th><th>Exchange</th><th>Lookup</th><th>Instrument key</th></tr></thead>
        <tbody>{(indexDiscovery.instruments||[]).map(item=><tr key={item.symbol}>
          <td>{item.symbol}</td><td>{item.exchange}</td><td>{item.status}</td>
          <td><code>{item.instrument_key||'Unresolved'}</code></td>
        </tr>)}</tbody>
      </table></div>
      <p className="terminal-footnote">Read-only provider search. Analytics credentials authorize lookup, but do not verify the provider account identity. Keys are candidates
        for independent operator/BOD verification only. Current-BOD attestation,
        exchange display/retention rights, licensed Rust index streaming, public
        redistribution and trading all remain disabled or unverified.</p>
    </section>}
    <p className="terminal-footnote">Read-only personal market data uses your stored
      Analytics Token. No OAuth, additional index plan or public market-data endpoint.
      Orders remain disabled.</p>
  </div>;
}
const SETUP_STEPS=Object.freeze([
  {label:'Providers',detail:'Market source overview'},
  {label:'Upstox Token',detail:'Read-only personal market data'},
]);
export function BrokersWorkspace({openView}){
  const [nativeRefreshTick,setNativeRefreshTick]=useState(0);
  const [step,setStep]=useState(0);
  const descriptions=[
    'Check which exchanges respond and choose a private data source.',
    'Store or verify your one-year read-only Upstox Analytics Token.',
  ];
  return <div className="terminal-page qt-unified qt-connections-page">
    <PanelTitle eyebrow="MARKET DATA · CONNECTION CENTER"
      title="Data providers & connections"
      description="One guided setup for public exchanges and authenticated private index data."/>
    <div className="qt-setup-progress" aria-label="Connection setup steps">
      {SETUP_STEPS.map((entry,i)=><button type="button" key={entry.label}
        className={'qt-setup-step'+(step===i?' selected':'')+(step>i?' complete':'')}
        aria-current={step===i?'step':undefined} onClick={()=>setStep(i)}>
        <span className="qt-setup-number">{step>i?'✓':i+1}</span>
        <span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
      </button>)}
    </div>
    <div className="qt-setup-layout">
      <div className="qt-setup-main terminal-surface">
        <div className="qt-setup-heading"><p className="terminal-eyebrow">STEP {step+1} OF {SETUP_STEPS.length}</p>
          <h2>{SETUP_STEPS[step].label}</h2>
          <p>{descriptions[step]}</p></div>
        {step===0&&<>
          <ProviderStatusPanel/>
          <div className="qt-setup-inline"><ShieldCheck size={18}/>
            <span>Public crypto health checks do not require a broker token.
              Indian indices require an independent private feed approval.</span></div>
        </>}
        {step===1&&<>
          <IndexHistoryProofPanel/>
          <div className="qt-actions"><button type="button"
            className="terminal-action terminal-secondary-action"
            onClick={()=>setNativeRefreshTick(t=>t+1)}>
            <RefreshCw size={16}/> Refresh Upstox status</button></div>
          <NativeUpstoxPanel refreshTick={nativeRefreshTick}/>
        </>}
        <div className="qt-setup-navigation">
          <button type="button" className="terminal-action terminal-secondary-action"
            onClick={()=>setStep(s=>Math.max(0,s-1))} disabled={step===0}>Previous</button>
          <button type="button" className="terminal-action"
            onClick={()=>setStep(s=>Math.min(SETUP_STEPS.length-1,s+1))}
            disabled={step===SETUP_STEPS.length-1}>Next step →</button>
        </div>
      </div>
      <aside className="qt-setup-aside terminal-surface" aria-label="Connection help">
        <div className="qt-setup-art" aria-hidden="true"><ShieldCheck size={42}/></div>
        <p className="terminal-eyebrow">SECURE BY DESIGN</p>
        <h2>One token. Your personal charts.</h2>
        <p>Store your Upstox Analytics Token once. QSYN privately retrieves
          exchange candles and current-day 1-minute OHLC without OAuth or
          manually prepared worker plans.</p>
        <div className="qt-setup-assurances">
          <div><ShieldCheck size={16}/><span>Single read-only Analytics Token · one-year validity</span></div>
          <div><LockKeyhole size={16}/><span>Private token storage and administrator session</span></div>
          <div><Activity size={16}/><span>Real Upstox OHLC timestamps, never synthetic candles</span></div>
        </div>
        <p className="terminal-footnote">Personal chart only. No public price
          redistribution or order execution.</p>
      </aside>
    </div>
  </div>;
}
export function OperationsWorkspace(){
  const [state,setState]=useState(null),[password,setPassword]=useState('');
  const [setupCode,setSetupCode]=useState(''),[freshPassword,setFreshPassword]=useState('');
  const [confirmPassword,setConfirmPassword]=useState(''),[busy,setBusy]=useState(false);
  const [message,setMessage]=useState('Only authenticated administrators can control the Rust process.');
  const [demo,setDemo]=useState(null);
  const [depth,setDepth]=useState(null);
  const refresh=useCallback(async()=>{
    try {
      const data=await jsonGet(ADMIN_API+'state');
      setState(data);
      if(data.authenticated){
        const [demoState,depthState]=await Promise.all([
          jsonGet(ADMIN_API+'demo').catch(()=>null),
          jsonGet(ADMIN_API+'depth').catch(()=>null),
        ]);
        setDemo(demoState);setDepth(depthState);
      }else{
        setDemo(null);setDepth(null);
      }
    }catch{setMessage('Administrator status unavailable');}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function execute(doRequest){
    if(busy)return;
    setBusy(true);
    try{await doRequest();await refresh();}
    catch(e){setMessage('Operation denied: '+String(e.message).slice(0,95));}
    finally{setBusy(false);}
  }
  const csrf=state?.authenticated?state.csrf:null;
  const ready=Boolean(csrf&&state?.manager?.available);
  return <div className="terminal-page qt-unified">
    <PanelTitle eyebrow="RESTRICTED OPERATIONS" title="Service administration"
      description="Existing QSYN admin session, CSRF, origin checks and restricted service manager remain enforced by PHP."/>
    <section className="terminal-surface">
      <div className="terminal-card-head"><h2>Rust process · 127.0.0.1:10251</h2>
        <Result ok={ready}>{state?.authenticated?'Administrator authenticated':'Restricted'}</Result></div>
      <p role="status" className="qt-message">{message}</p>
      <p>Manager: {state?.authenticated?(state.manager?.state||'unavailable'):'Sign in to view'} · Trading actions unavailable.</p>
      {!state?.configured&&state?.setup?.available&&<form className="qt-form" autoComplete="off"
        onSubmit={e=>{e.preventDefault();
          if(freshPassword!==confirmPassword||freshPassword.length<20){
            setMessage('Passwords must match and be at least 20 characters.');return;
          }
          void execute(async()=>{
            await adminPost('setup',{setup_code:setupCode,new_password:freshPassword},state.setup.csrf);
            setSetupCode('');setFreshPassword('');setConfirmPassword('');
            setMessage('Administrator setup completed. Sign in with the new password.');
          });
        }}>
        <h3>First-time administrator setup</h3>
        <p>Retrieve the one-time setup code from Cloudways private storage, never from a website URL.</p>
        <label>Private setup code<input type="password" required minLength={64} maxLength={64} value={setupCode} onChange={e=>setSetupCode(e.target.value)} autoComplete="off"/></label>
        <label>New password (20+ characters)<input type="password" required minLength={20} value={freshPassword} onChange={e=>setFreshPassword(e.target.value)} autoComplete="new-password"/></label>
        <label>Confirm password<input type="password" required minLength={20} value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} autoComplete="new-password"/></label>
        <button className="terminal-action" disabled={busy}>Create admin password</button>
      </form>}
      {state?.configured&&!state?.authenticated&&<form className="qt-form" onSubmit={e=>{
        e.preventDefault();
        void execute(async()=>{
          await adminPost('login',{password});
          setPassword('');setMessage('Admin session verified.');
        });
      }}>
        <label>Dedicated QSYN admin password<input type="password" required value={password}
          onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label>
        <button className="terminal-action" disabled={busy}>Sign in to operations</button>
      </form>}
      {state?.authenticated&&<>
        <div className="qt-actions">
          {['start','stop','restart'].map(action=><button key={action}
            className="terminal-action terminal-secondary-action" disabled={busy||!ready}
            onClick={()=>{if(window.confirm('Confirm QSYN Rust service '+action+'?'))
              void execute(async()=>{await adminPost('action',{action},csrf);setMessage('Service '+action+' accepted.');});}}>
            {action==='start'?'Start':action==='stop'?'Stop':'Restart'}</button>)}
          <button className="terminal-action terminal-secondary-action" disabled={busy}
            onClick={()=>void execute(async()=>{await adminPost('logout',{},csrf);setMessage('Administrator signed out.');})}>Sign out</button>
        </div>
        <div className="qt-operations-warning">
          <strong>Binance order-book snapshots</strong>
          <p role="status">State: {depth?.enabled===true?'Enabled':depth?.enabled===false?'Disabled':'Unverified'} ·
            {' '}Runtime: {depth?.engine_online?'online':'offline'} · Read-only; no trades or historical liquidity.
            {' '}Changes apply without a Rust restart.</p>
          {!depth?.supported&&<p>Upgrade the running Rust binary to this release before using the controls.</p>}
          {depth?.supported&&!depth?.writable&&<p>Private QSYN runtime must be writable by the PHP application.</p>}
          <div className="qt-actions">
            {['Enable','Disable'].map((name,i)=>{
              const enabled=i===0;
              return <button key={name} className="terminal-action terminal-secondary-action"
                disabled={busy||!csrf||!depth?.supported||!depth?.writable||!depth?.engine_online||
                  depth.enabled===enabled}
                onClick={()=>{
                  if(enabled&&!window.confirm('Enable public Binance BTC/ETH order-book snapshots? Confirm exchange display permissions and intended access restrictions.'))return;
                  void execute(async()=>{
                    const result=await adminPost('depth',{enabled},csrf);
                    if(result.enabled!==enabled)throw Error('depth_state_not_confirmed');
                    setMessage('Crypto depth '+(enabled?'enabled':'disabled')+' and verified by Rust.');
                  });
                }}>{name} crypto depth</button>;
            })}
          </div>
        </div>
        <div className="qt-actions"><span>Demo WebSocket mode: {demo?.enabled===true?'Enabled':demo?.enabled===false?'Disabled':'Unverified'}</span>
          {['Enable','Disable'].map((name,i)=><button key={name} className="terminal-action terminal-secondary-action"
            disabled={busy||!demo?.supported||!demo?.writable||!demo?.engine_online||
              demo?.enabled===!i}
            onClick={()=>void execute(async()=>{
              await adminPost('demo',{enabled:i===0},csrf);setMessage('Demo-only stream updated.');
            })}>{name} demo</button>)}</div>
      </>}
      {!state?.configured&&!state?.setup?.available&&<p className="terminal-footnote">Admin setup unavailable; check private Cloudways runtime permissions. No access is granted by this screen.</p>}
      <div className="qt-actions"><button className="terminal-action terminal-secondary-action" onClick={()=>void refresh()} disabled={busy}>
        <RefreshCw size={16}/> Refresh status</button></div>
    </section>
    <section className="terminal-surface"><h2>Security boundaries</h2>
      <p>Admin controls remain protected by the existing PHP API. This React view cannot bypass server authorization, activate broker orders, view private OAuth tokens or execute arbitrary shell commands.</p>
    </section>
  </div>;
}

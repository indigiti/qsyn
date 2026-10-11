import React, {useEffect,useState,useCallback} from 'react';
import {Activity,AlertTriangle,CheckCircle2,ClipboardCopy,LockKeyhole,RefreshCw,Server,ShieldCheck,Wallet,Wifi,WifiOff} from 'lucide-react';
import {CRYPTO_MARKETS} from './crypto-catalog.js';
import {INDIA_INDEX_MARKETS} from './india-index-catalog.js';
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
const OPENALGO_API='/qsyn/api/v1/brokers/openalgo/';
const OPENALGO_ADMIN='/qsyn/api/v1/admin/openalgo/';
const BROKER_LABELS={upstox:'Upstox',zerodha:'Zerodha',angel:'Angel One',dhan:'Dhan',
  fyers:'Fyers',shoonya:'Shoonya',groww:'Groww',aliceblue:'Alice Blue',flattrade:'FlatTrade',
  fivepaisa:'5paisa'};
async function openAlgoAdminPost(operation, account_id, csrf){
  const res=await fetch(OPENALGO_ADMIN+operation,{method:'POST',credentials:'same-origin',
    cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json',
      'X-CSRF-Token':csrf},body:JSON.stringify({account_id})});
  const json=await res.json();
  if(!res.ok)throw Error(json.error||'operator_action_denied');
  return json;
}
const NATIVE_UPSTOX_API='/qsyn/api/v1/admin/upstox/';
function NativeUpstoxPanel(){
  const [status,setStatus]=useState(null),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('Checking native Upstox authorization readiness…');
  const [form,setForm]=useState({client_id:'',client_secret:'',expected_user_id:'',confirmed:false});
  const load=useCallback(async()=>{
    try{
      const data=await jsonGet(NATIVE_UPSTOX_API+'status');
      if(data.schema!=='QSYN-NATIVE-UPSTOX-WEB/1')throw Error('unexpected_schema');
      setStatus(data);
      setNotice(data.token_stored
        ?'A provider-identity-checked Upstox token is stored privately. Current validity, index display rights and live feed remain unverified.'
        :data.configured?'Upstox app configured. Authorize using your Upstox login.':'Set up your Upstox Developer App before authorizing.');
    }catch{setStatus(null);setNotice('Native Upstox setup is unavailable; check the QSYN administrator session and private runtime.');}
  },[]);
  useEffect(()=>{void load();},[load]);
  async function action(operation,payload){
    if(!status?.csrf||busy)return;
    setBusy(true);
    try{
      const r=await fetch(NATIVE_UPSTOX_API+operation,{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':status.csrf},
        body:JSON.stringify(payload)});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'upstox_action_denied');
      if(operation==='setup'){
        setForm({client_id:'',client_secret:'',expected_user_id:'',confirmed:false});
        await load();
        setNotice('Upstox application saved privately. Register the exact callback URL in Upstox, then select Connect Upstox.');
      }else if(operation==='begin'){
        const url=new URL(data.authorization_url);
        if(url.protocol!=='https:'||url.hostname!=='api.upstox.com'
          ||url.pathname!=='/v2/login/authorization/dialog'
          ||url.searchParams.get('response_type')!=='code'
          ||!url.searchParams.get('state'))throw Error('invalid_upstox_authorize_url');
        window.location.assign(url.href);
      }
    }catch(e){setNotice('Upstox authorization unavailable: '+String(e.message).slice(0,100));}
    finally{setBusy(false);}
  }
  return <div className="qt-openalgo-setup">
    <p role="status" className="qt-message">{notice}</p>
    <div className="qt-summary">
      <div><strong>Upstox OAuth token</strong><p>{status?.token_stored?'Stored privately · session validity not checked':status?.configured?'Authorization required':'Not configured'}</p></div>
      <div><strong>Index feed / license</strong><p>Not activated · no live prices</p></div>
      <div><strong>QSYN order execution</strong><p>Disabled</p></div>
    </div>
    {status&&!status.configured&&<form className="qt-form qt-openalgo-setup"
      onSubmit={e=>{e.preventDefault();void action('setup',form);}} autoComplete="off">
      <h3>Configure Upstox developer application</h3>
      <p>Use the API key and API secret issued by your own Upstox Developer App.
        These are NOT OpenAlgo credentials. QSYN stores them only in its private server directory.</p>
      <label>Upstox application API key
        <input required minLength={8} maxLength={128} autoComplete="off"
          value={form.client_id} onChange={e=>setForm(p=>({...p,client_id:e.target.value}))}/></label>
      <label>Upstox application API secret
        <input required type="password" minLength={8} maxLength={512} autoComplete="off"
          value={form.client_secret} onChange={e=>setForm(p=>({...p,client_secret:e.target.value}))}/></label>
      <label>Expected Upstox User ID (account verification)
        <input required minLength={2} maxLength={128} autoComplete="off"
          value={form.expected_user_id} onChange={e=>setForm(p=>({...p,expected_user_id:e.target.value}))}/></label>
      <p className="terminal-footnote">Set your Upstox app's exact redirect URI to:
        <code>{status.oauth_callback_uri}</code>
      </p>
      <label className="qt-setup-confirm">
        <input type="checkbox" checked={form.confirmed}
          onChange={e=>setForm(p=>({...p,confirmed:e.target.checked}))}/>
        I control this Upstox developer application and have registered the callback URL.
        The account will be used for authorized market data only; no trading is activated.
      </label>
      <button className="terminal-action" type="submit" disabled={busy||!form.confirmed}>
        Save Upstox application</button>
    </form>}
    {status?.configured&&<div className="qt-actions">
      <button type="button" className="terminal-action" disabled={busy}
        onClick={()=>void action('begin',{})}>Connect Upstox (OAuth)</button>
      <button type="button" className="terminal-action terminal-secondary-action" disabled={busy}
        onClick={()=>void load()}><RefreshCw size={16}/> Refresh OAuth status</button>
    </div>}
    <p className="terminal-footnote">Provider login and consent happen on Upstox.
      QSYN checks the returned user ID and stores the access token in a 0600 private file.
      A stored token is not proof of a currently active WebSocket, an exchange data license,
      or permission to redistribute NSE/BSE prices. Trading stays disabled.</p>
  </div>;
}
export function BrokersWorkspace({openView}){
  const [catalog,setCatalog]=useState(null),[admin,setAdmin]=useState(null);
  const [inventory,setInventory]=useState(null),[selected,setSelected]=useState('upstox');
  const [message,setMessage]=useState('No production broker session verified');
  const [statuses,setStatuses]=useState({}),[loginTarget,setLoginTarget]=useState(null);
  const [busy,setBusy]=useState(false),[indexCatalog,setIndexCatalog]=useState(null);
  const [setup,setSetup]=useState({account_id:'upstox-a',rest_port:'5000',
    ws_port:'8765',login_url:'',application_api_key:'',confirmed:false});
  const refresh=useCallback(async(signal)=>{
    const [names,auth,indexes]=await Promise.all([
      jsonGet(OPENALGO_API+'catalog',signal).catch(()=>null),
      jsonGet(ADMIN_API+'state',signal).catch(()=>null),
      jsonGet('/qsyn/api/v1/india/indexes',signal).catch(()=>null),
    ]);
    if(signal?.aborted)return;
    setCatalog(names?.schema==='QSYN-OPENALGO-CONNECTIONS/1'?names:null);
    setAdmin(auth);
    setIndexCatalog(indexes);
    setLoginTarget(null);setStatuses({});
    if(auth?.authenticated&&selected!=='upstox'){
      try{
        const data=await jsonGet(OPENALGO_ADMIN+'accounts',signal);
        if(signal?.aborted)return;
        setInventory(data?.schema==='QSYN-OPENALGO-ADMIN-READINESS/1'?data:null);
        setMessage(data?.accounts?.length
          ?'Choose an approved account to check its OpenAlgo session.'
          :'No private OpenAlgo account registered.');
      }catch(e){
        if(signal?.aborted)return;
        setInventory(null);
        setMessage('Private OpenAlgo not provisioned or unavailable. No broker session verified.');
      }
    }else{setInventory(null);setMessage('No production broker session verified');}
  },[selected]);
  useEffect(()=>{
    const ctl=new AbortController();void refresh(ctl.signal);
    return()=>ctl.abort();
  },[refresh]);
  const brokers=catalog?.brokers||[];
  const accounts=(inventory?.accounts||[]).filter(a=>a.broker===selected);
  const hasAdmin=Boolean(admin?.authenticated);
  async function inspect(account){
    if(busy||!inventory?.csrf)return;
    setBusy(true);setLoginTarget(null);
    try{
      const data=await openAlgoAdminPost('inspect',account.account_id,inventory.csrf);
      if(data.schema!=='QSYN-OPENALGO-ADMIN-READINESS/1'
        || data.account_id!==account.account_id)throw Error('unverified_server_response');
      setStatuses(old=>({...old,[account.account_id]:data.session_state}));
      setMessage(data.openalgo_application_session_responding
        ?'OpenAlgo session responds for '+account.account_id+
          '. Upstox account identity, OAuth callback and exchange display rights are NOT verified.'
        :'OpenAlgo session unavailable or expired for '+account.account_id+'.');
    }catch(e){setMessage('Verification denied: '+String(e.message).slice(0,90));}
    finally{setBusy(false);}
  }
  async function connect(account){
    if(busy||!account.login_available||!inventory?.csrf)return;
    setBusy(true);setLoginTarget(null);
    try{
      const result=await openAlgoAdminPost('connect',account.account_id,inventory.csrf);
      if(result.schema!=='QSYN-OPENALGO-ADMIN-READINESS/1'
        || result.account_id!==account.account_id)throw Error('invalid_connection_response');
      const url=new URL(result.login_url);
      if(url.protocol!=='https:'||url.pathname!=='/login'||url.search||url.hash||
        url.username||url.password||url.port)throw Error('unsafe_login_destination');
      setLoginTarget({account_id:account.account_id,url:url.href});
      setMessage('Approved OpenAlgo login is ready for '+account.account_id+
        '. Sign in there, return here and select Verify session.');
    }catch(e){setMessage('OpenAlgo login unavailable: '+String(e.message).slice(0,95));}
    finally{setBusy(false);}
  }
  async function saveSetup(e){
    e.preventDefault();
    if(busy||!inventory?.setup_available||!inventory.csrf)return;
    setBusy(true);
    try{
      const payload={
        account_id:setup.account_id.trim(),broker:selected,
        rest_port:Number(setup.rest_port),ws_port:Number(setup.ws_port),
        login_url:setup.login_url.trim(),
        application_api_key:setup.application_api_key.trim(),
        confirmed:setup.confirmed,
      };
      const r=await fetch(OPENALGO_ADMIN+'setup',{method:'POST',
        credentials:'same-origin',cache:'no-store',headers:{
          'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':inventory.csrf},body:JSON.stringify(payload)});
      const data=await r.json();
      if(!r.ok||data.schema!=='QSYN-OPENALGO-ADMIN-SETUP/1'
        ||!data.configuration_saved)throw Error(data.error||'setup_rejected');
      setSetup(old=>({...old,application_api_key:'',confirmed:false}));
      await refresh(new AbortController().signal);
      setMessage('Private QSYN connection profile saved. OpenAlgo must already be installed on the configured private service; use Verify session to check it.');
    }catch(e){setMessage('Private setup failed: '+String(e.message).slice(0,100));}
    finally{setBusy(false);}
  }
  return <div className="terminal-page qt-unified">
    <PanelTitle eyebrow="BROKER CONNECTIONS · RUST DATA" title="Accounts & authorizations"
      description="Native Upstox V3 index market data uses the QSYN Rust WebSocket engine. Other broker plugins remain separately gated."/>
    <div className="qt-summary">
      <section className="terminal-surface"><Wallet size={19}/><span>Configured accounts</span>
        <strong>{selected==='upstox'?'Native Upstox':(hasAdmin?(inventory?.accounts?.length??'Not provisioned'):'Restricted')}</strong></section>
      <section className="terminal-surface"><LockKeyhole size={19}/><span>Exchange display rights</span>
        <strong>Not verified</strong></section>
      <section className="terminal-surface"><ShieldCheck size={19}/><span>QSYN order execution</span>
        <strong>Disabled</strong></section>
    </div>
    <section className="terminal-surface">
      <div className="terminal-card-head"><h2>Select broker</h2><ShieldCheck size={18}/></div>
      <div className="qt-broker-grid">
        {brokers.map(b=><button type="button" key={b} onClick={()=>{setSelected(b);setLoginTarget(null);}}
          className={'qt-broker-card'+(b===selected?' selected':'')} aria-pressed={b===selected}>
          <span className="qt-broker-avatar">{(BROKER_LABELS[b]||b).slice(0,2).toUpperCase()}</span>
          <span>{BROKER_LABELS[b]||b}</span>
        </button>)}
      </div>
      {!catalog&&<p>Broker catalog is temporarily unavailable.</p>}
      <p role="status" className="qt-message">{selected==='upstox'?'Native Upstox OAuth and index data subscription are not activated; no OpenAlgo API key is required.':message}</p>
      <button className="terminal-action terminal-secondary-action" disabled={busy}
        onClick={()=>void refresh(new AbortController().signal)}>
        <RefreshCw size={16}/> Refresh broker status
      </button>
    </section>
    {selected==='upstox'&&<section className="terminal-surface">
      <div className="terminal-card-head"><h2>Native Upstox → QSYN Rust V3</h2><ShieldCheck size={18}/></div>
      <p>Connect directly to Upstox. Its Market Data Feed V3 is decoded by the Rust streaming
        engine and distributed to authorized React index charts. No OpenAlgo application key,
        OpenAlgo Python runtime, or trading connection is required.</p>
      <NativeUpstoxPanel/>
      <p className="terminal-footnote">Native Rust index subscriptions and licensed candle backfill
        are not activated until current instrument keys and exchange data entitlement are verified.</p>
      <button type="button" className="terminal-action terminal-secondary-action"
        onClick={()=>openView('private-live')}>View Rust chart readiness</button>
    </section>}
    {selected!=='upstox'&&<section className="terminal-surface">
      <div className="terminal-card-head"><h2>{BROKER_LABELS[selected]||selected} · optional OpenAlgo integration</h2>
        <LockKeyhole size={18}/></div>
      {!hasAdmin&&<div>
        <p>Use your existing QSYN administrator login to access private broker connections. No terminal commands are needed to check a provisioned session.</p>
        <div className="qt-actions"><button className="terminal-action"
          onClick={()=>openView('operations')}>Sign in through Operations</button></div>
      </div>}
      {hasAdmin&&accounts.length===0&&<p>No approved OpenAlgo account is registered for this broker. Cloudways/OpenAlgo provisioning is still required before login can work.</p>}
      {hasAdmin&&inventory?.configuration_state==='not_provisioned'&&
        inventory?.setup_available&&<form className="qt-form qt-openalgo-setup"
        onSubmit={e=>void saveSetup(e)} autoComplete="off">
        <h3>Configure first OpenAlgo connection</h3>
        <p>This creates QSYN's private, one-time operator account profile. An isolated
          OpenAlgo Python service and its HTTPS login must already be installed and approved.
          This form does not install OpenAlgo or authorize Upstox.</p>
        <label>QSYN account label
          <input required maxLength={48} pattern="[A-Za-z0-9_-]+"
            value={setup.account_id} onChange={e=>setSetup(x=>({...x,account_id:e.target.value}))}
            placeholder="upstox-a"/></label>
        <label>OpenAlgo HTTPS login address
          <input required type="url" maxLength={350}
            value={setup.login_url} onChange={e=>setSetup(x=>({...x,login_url:e.target.value}))}
            placeholder="https://your-approved-openalgo-domain/login"/></label>
        <div className="qt-setup-ports">
          <label>Private REST port
            <input required type="number" min={1025} max={65535} value={setup.rest_port}
              onChange={e=>setSetup(x=>({...x,rest_port:e.target.value}))}/></label>
          <label>Private WebSocket port
            <input required type="number" min={1025} max={65535} value={setup.ws_port}
              onChange={e=>setSetup(x=>({...x,ws_port:e.target.value}))}/></label>
        </div>
        <label>OpenAlgo application API key (not the Upstox API secret)
          <input required type="password" minLength={16} maxLength={256}
            value={setup.application_api_key}
            onChange={e=>setSetup(x=>({...x,application_api_key:e.target.value}))}
            autoComplete="off" placeholder="Enter the API key from your approved OpenAlgo instance"/></label>
        <label className="qt-setup-confirm">
          <input type="checkbox" checked={setup.confirmed}
            onChange={e=>setSetup(x=>({...x,confirmed:e.target.checked}))}/>
          I confirm the OpenAlgo service and HTTPS login belong to my approved private installation,
          and understand that saving this profile does not verify Upstox OAuth or enable trading.
        </label>
        <button className="terminal-action" type="submit" disabled={busy||!setup.confirmed}>
          <ShieldCheck size={16}/> Save private connection profile
        </button>
        <p className="terminal-footnote">This one-time setup writes owner-only 0600 files
          outside public_html. Keys are never returned to the browser.
          Existing profiles cannot be overwritten by this form.</p>
      </form>}
      {hasAdmin&&inventory?.configuration_state==='not_provisioned'&&
        !inventory?.setup_available&&<p className="terminal-footnote">
        Configuration is managed externally or the private runtime is not writable by
        QSYN. An authorized Cloudways operator must approve the private service and storage.
      </p>}
      {hasAdmin&&accounts.length>0&&<div className="qt-broker-accounts">
        {accounts.map(account=><div key={account.account_id} className="qt-broker-account">
          <strong>{account.account_id}</strong>
          <span>Session: {statuses[account.account_id]||'Not checked'}</span>
          <div className="qt-actions">
            <button type="button" className="terminal-action" disabled={busy||!account.login_available}
              onClick={()=>void connect(account)}>Connect with OpenAlgo</button>
            <button type="button" className="terminal-action terminal-secondary-action" disabled={busy}
              onClick={()=>void inspect(account)}>Verify session</button>
          </div>
        </div>)}
      </div>}
      {loginTarget&&<p className="qt-login-link">
        <a href={loginTarget.url} target="_blank" rel="noopener noreferrer">
          Open approved OpenAlgo login for {loginTarget.account_id}
        </a>
      </p>}
      <p className="terminal-footnote">A responding OpenAlgo application API does not prove which Upstox trading account is logged in or confirm exchange data licenses. Native OpenAlgo order permissions must be restricted separately. Neither QSYN nor this screen can install or activate the Python broker service.</p>
      <div className="qt-actions">
        <button className="terminal-action terminal-secondary-action" onClick={()=>openView('private-live')}>
          Private chart readiness</button>
        <button className="terminal-action terminal-secondary-action" onClick={()=>openView('diagnostics')}>
          Feed diagnostics</button>
      </div>
    </section>}
    <section className="terminal-surface"><h2>NSE / BSE index catalog</h2>
      <div className="qt-market-tags">{INDIA_INDEX_MARKETS.map(x=><span key={x.id}>
        {x.name} · {x.exchange==='BSE_INDEX'?'BSE':'NSE'}</span>)}</div>
      <p className="terminal-footnote">{indexCatalog?.indexes?.length===6
        ?'Index discovery operational.':'Index discovery unavailable.'}
        {' '}Live candles remain gated by exchange display entitlement and separately verified broker access.</p>
    </section>
  </div>;
}
export function OperationsWorkspace(){
  const [state,setState]=useState(null),[password,setPassword]=useState('');
  const [setupCode,setSetupCode]=useState(''),[freshPassword,setFreshPassword]=useState('');
  const [confirmPassword,setConfirmPassword]=useState(''),[busy,setBusy]=useState(false);
  const [message,setMessage]=useState('Only authenticated administrators can control the Rust process.');
  const [demo,setDemo]=useState(null);
  const refresh=useCallback(async()=>{
    try {
      const data=await jsonGet(ADMIN_API+'state');
      setState(data);
      setDemo(data.authenticated
        ?await jsonGet(ADMIN_API+'demo').catch(()=>null):null);
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

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
const BROKER_LABELS={upstox:'Upstox',zerodha:'Zerodha',angel:'Angel One',dhan:'Dhan',fyers:'Fyers',shoonya:'Shoonya',groww:'Groww',aliceblue:'Alice Blue',flattrade:'FlatTrade',fivepaisa:'5paisa'};
export function BrokersWorkspace({openView}){
  const [catalog,setCatalog]=useState(null),[privateState,setPrivateState]=useState(null);
  const [indexCatalog,setIndexCatalog]=useState(null),[message,setMessage]=useState('No production broker session verified');
  const [busy,setBusy]=useState(false),[selected,setSelected]=useState('upstox');
  const refresh=useCallback(async(signal)=>{
    const [brokers,accounts,indexes]=await Promise.all([
      jsonGet(OPENALGO_API+'catalog',signal).catch(()=>null),
      jsonGet(OPENALGO_API+'accounts',signal).catch(()=>null),
      jsonGet('/qsyn/api/v1/india/indexes',signal).catch(()=>null),
    ]);
    if(signal?.aborted)return;
    setCatalog(brokers?.schema==='QSYN-OPENALGO-CONNECTIONS/1'?brokers:null);
    setPrivateState(accounts?.schema==='QSYN-OPENALGO-CONNECTIONS/1' &&
      accounts?.profile==='private_development_only'?accounts:null);
    setIndexCatalog(indexes);
  },[]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  const brokers=catalog?.brokers||[];
  const accounts=(privateState?.accounts||[]).filter(x=>x.broker===selected);
  async function connect(account){
    if(busy||!account?.login_available||!privateState?.csrf)return;
    setBusy(true);setMessage('Requesting an approved private OpenAlgo login…');
    try{
      const r=await fetch(OPENALGO_API+'connect',{method:'POST',credentials:'same-origin',
        cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json',
          'X-CSRF-Token':privateState.csrf},body:JSON.stringify({account_id:account.account_id})});
      const data=await r.json();
      if(!r.ok||data.schema!=='QSYN-OPENALGO-CONNECTIONS/1'||data.account_id!==account.account_id||
        typeof data.login_url!=='string')throw Error(data.error||'connection_not_available');
      const target=new URL(data.login_url);
      if(target.protocol!=='https:'||target.pathname!=='/login'||target.search||target.hash)
        throw Error('invalid_login_destination');
      // OpenAlgo owns the actual session and broker consent in a separate secure tab.
      window.open(target.href,'_blank','noopener,noreferrer');
      setMessage('OpenAlgo login opened where your browser permits popups. Return here and verify the session.');
    }catch(e){setMessage('Connection unavailable: '+String(e.message).slice(0,100));}
    finally{setBusy(false);}
  }
  async function verify(account){
    if(busy)return;
    setBusy(true);
    try{
      const data=await jsonGet(OPENALGO_API+'status?account_id='+encodeURIComponent(account.account_id));
      setMessage(data.session_state==='openalgo_session_responding'
        ?'OpenAlgo broker session responds for '+account.account_id+'. Broker identity and market-data rights remain unverified.'
        :'No responding broker session for '+account.account_id+'. Sign in to its approved OpenAlgo instance.');
    }catch{setMessage('Broker verification unavailable; private identity or OpenAlgo runtime may not be enabled.');}
    finally{setBusy(false);}
  }
  return <div className="terminal-page qt-unified">
    <PanelTitle eyebrow="BROKER CONNECTIONS · OPENALGO" title="Accounts & authorizations"
      description="Choose a supported Indian broker. Actual sign-in stays within an independently managed OpenAlgo instance."/>
    <div className="qt-summary">
      <section className="terminal-surface"><Wallet size={19}/><span>Private accounts</span><strong>{privateState?.accounts?.length??'Not available'}</strong></section>
      <section className="terminal-surface"><LockKeyhole size={19}/><span>Exchange display rights</span><strong>Not verified</strong></section>
      <section className="terminal-surface"><ShieldCheck size={19}/><span>Order execution</span><strong>Disabled</strong></section>
    </div>
    <section className="terminal-surface">
      <div className="terminal-card-head"><h2>Select broker</h2><ShieldCheck size={18}/></div>
      <div className="qt-broker-grid">
        {brokers.map(b=><button type="button" key={b} onClick={()=>setSelected(b)}
          className={'qt-broker-card'+(b===selected?' selected':'')}
          aria-pressed={b===selected}>
          <span className="qt-broker-avatar">{(BROKER_LABELS[b]||b).slice(0,2).toUpperCase()}</span>
          <span>{BROKER_LABELS[b]||b}</span>
        </button>)}
      </div>
      {!catalog&&<p className="terminal-footnote">Broker catalog unavailable. No account connection is implied.</p>}
      <p role="status" className="qt-message">{message}</p>
      <div className="qt-actions"><button className="terminal-action terminal-secondary-action" disabled={busy}
        onClick={()=>void refresh(new AbortController().signal)}><RefreshCw size={16}/> Refresh accounts</button></div>
    </section>
    <section className="terminal-surface">
      <div className="terminal-card-head"><h2>{BROKER_LABELS[selected]||selected} connections</h2><LockKeyhole size={18}/></div>
      {accounts.length===0?<p>No authorized private OpenAlgo instance is configured for this broker and your account. Broker selection does not grant access.</p>:
        <div className="qt-broker-accounts">{accounts.map(account=><div key={account.account_id} className="qt-broker-account">
          <strong>{account.account_id}</strong><span>Session: {account.session_state||'Not checked'}</span>
          <div className="qt-actions"><button className="terminal-action" disabled={busy||!account.login_available}
            onClick={()=>void connect(account)}>Connect with OpenAlgo</button>
            <button className="terminal-action terminal-secondary-action" disabled={busy}
              onClick={()=>void verify(account)}>Verify session</button></div>
        </div>)}</div>}
      <p className="terminal-footnote">This workflow is disabled by default and uses development-private QSYN identity only. OpenAlgo receives broker credentials on its own authenticated site; QSYN never accepts a browser-supplied broker token, port or redirect target.</p>
      <div className="qt-actions">
        <button className="terminal-action terminal-secondary-action" onClick={()=>openView('private-live')}>Private chart readiness</button>
        <button className="terminal-action terminal-secondary-action" onClick={()=>openView('diagnostics')}>Feed diagnostics</button>
      </div>
    </section>
    <section className="terminal-surface"><h2>NSE / BSE index catalog</h2>
      <div className="qt-market-tags">{INDIA_INDEX_MARKETS.map(x=><span key={x.id}>{x.name} · {x.exchange==='BSE_INDEX'?'BSE':'NSE'}</span>)}</div>
      <p className="terminal-footnote">{indexCatalog?.indexes?.length===6?'Index discovery operational.':'Index discovery unavailable.'} Live candles remain blocked until account-specific exchange display rights and real provider data are verified.</p>
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

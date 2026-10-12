import React,{useEffect,useState,useCallback} from 'react';
import {RefreshCw,ShieldCheck,LockKeyhole} from 'lucide-react';
import './terminal-unified.css';

const API='/qsyn/api/v1/admin/index-prepare/';
const ALIAS=/^[A-Za-z0-9_.:-]{2,80}$/;
/** Safe draft preparation only; no browser entitlement toggle or private path. */
export function IndexProvisionPanel(){
  const [status,setStatus]=useState(null);
  const [busy,setBusy]=useState(false);
  const [scope,setScope]=useState({tenant:'qsyn-operator',owner:'qsyn-admin',account:''});
  const [confirmed,setConfirmed]=useState(false);
  const [notice,setNotice]=useState('');
  const refresh=useCallback(async(signal)=>{
    try{
      const r=await fetch(API+'status',{credentials:'same-origin',cache:'no-store',
        signal,headers:{Accept:'application/json'}});
      const j=await r.json();
      if(!r.ok||j.schema!=='QSYN-INDEX-PRIVATE-PROVISIONING/1')
        throw Error(j.error||'INDEX_PREPARATION_UNAVAILABLE');
      if(!signal?.aborted){setStatus(j);}
    }catch(e){
      if(!signal?.aborted){setStatus(null);setNotice(
        /^[A-Z0-9_]{3,90}$/i.test(e.message||'')?e.message:'INDEX_PREPARATION_UNAVAILABLE');}
    }
  },[]);
  useEffect(()=>{const c=new AbortController();void refresh(c.signal);return()=>c.abort();},[refresh]);
  const prepared=status?.plan_prepared===true;
  async function prepare(e){
    e.preventDefault();
    if(!status?.csrf||!confirmed||busy||prepared||
      !Object.values(scope).every(v=>ALIAS.test(v)))return;
    setBusy(true);setNotice('');
    try{
      const r=await fetch(API+'prepare',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json','X-CSRF-Token':status.csrf,
          Accept:'application/json'},body:JSON.stringify({confirmed:true,...scope})
      });
      const j=await r.json();
      if(!r.ok||j.schema!=='QSYN-INDEX-PRIVATE-PROVISIONING/1')
        throw Error(j.error||'INDEX_PREPARATION_FAILED');
      setNotice(j.code||'INDEX_PRIVATE_DRAFT_PREPARED_NO_RIGHTS');
      setConfirmed(false);
      await refresh();
    }catch(err){setNotice(/^[A-Z0-9_]{3,90}$/i.test(err.message||'')
      ?err.message:'INDEX_PREPARATION_FAILED');}
    finally{setBusy(false);}
  }
  return <section aria-label="Private index preparation" className="qt-private-prepare">
    <h2>Prepare your private index workspace</h2>
    <p>Use the same protected server storage as your Upstox token. QSYN discovers
      the six index candidates itself and creates a non-trading draft plan and
      private history folders, without Cloudways console commands.</p>
    <div className="qt-prepare-checks">
      <div><span>Private storage</span><strong>{status?.private_storage_ready?'Ready':'Unavailable'}</strong></div>
      <div><span>Upstox account binding</span><strong>{status?.account_binding_ready?'Configured':'Required'}</strong></div>
      <div><span>Worker plan</span><strong>{prepared?'Draft saved':status?.plan_file_present?'Existing file':'Not prepared'}</strong></div>
      <div><span>History archive</span><strong>{status?.archive_prepared?'Private folder ready':'Not prepared'}</strong></div>
    </div>
    {!prepared&&!status?.plan_file_present&&<form onSubmit={prepare} className="qt-private-prepare-form">
      <p className="terminal-footnote">Enter local workspace aliases only. These identify
        your intended private scope; they are not Upstox credentials or legal approvals.</p>
      <div className="qt-private-prepare-fields">
        {['tenant','owner','account'].map(field=><label key={field}>
          {field==='tenant'?'Workspace / tenant alias':field==='owner'?'Operator alias':'Account alias'}
          <input required maxLength={80} pattern="[A-Za-z0-9_.:-]{2,80}"
            value={scope[field]} autoComplete="off"
            placeholder={field==='account'?'e.g. upstox-primary':''}
            onChange={e=>setScope(s=>({...s,[field]:e.target.value}))}/>
        </label>)}
      </div>
      <label className="qt-prepare-confirm"><input type="checkbox"
        checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
        I understand this prepares an <strong>unapproved draft</strong>; it does not authorize
        exchange data, start a worker, or display live index candles.</label>
      <div className="qt-actions">
        <button type="submit" className="terminal-action"
          disabled={busy||!confirmed||!status?.account_binding_ready||
            !status?.private_storage_ready||!Object.values(scope).every(x=>ALIAS.test(x))}>
          <ShieldCheck size={16}/>{busy?'Preparing…':'Prepare private index files'}
        </button>
        <button className="terminal-action terminal-secondary-action" type="button"
          disabled={busy} onClick={()=>void refresh()}>
          <RefreshCw size={15}/> Refresh
        </button>
      </div>
    </form>}
    {prepared&&<p role="status" className="qt-message">Draft saved with six candidate index keys.
      The plan remains intentionally inactive pending independent BOD, account and
      display/retention approval. No rights file or entitlement was fabricated.</p>}
    {!!status?.plan_file_present&&!prepared&&<p role="status" className="qt-message">
      A private plan already exists. QSYN will not overwrite it through this wizard.</p>}
    {notice&&<p role="status" className="qt-message">{notice}</p>}
    <p className="terminal-footnote"><LockKeyhole size={13} aria-hidden="true"/>
      {' '}No secrets, broker instrument keys, file paths or approval flags are accepted
      from the browser. The next step validates independently approved rights with the
      existing Rust checks. Unapproved drafts always fail the live-feed gate.</p>
  </section>;
}

import React,{useCallback,useEffect,useState} from 'react';
import {RefreshCw,ShieldCheck,LockKeyhole} from 'lucide-react';
import './terminal-unified.css';

const ROOT='/qsyn/api/v1/admin/index-ops/';
function lastCompletedIst(){
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',
    year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'});
  const parts=Object.fromEntries(fmt.formatToParts(new Date())
    .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const d=new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day));
  d.setUTCDate(d.getUTCDate()-1);
  while(d.getUTCDay()===0||d.getUTCDay()===6)
    d.setUTCDate(d.getUTCDate()-1);
  return d.toISOString().slice(0,10);
}
export function IndexWebOperationsPanel(){
  const [status,setStatus]=useState(null);
  const [date,setDate]=useState(lastCompletedIst);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [report,setReport]=useState(null);
  const reload=useCallback(async(signal)=>{
    try{
      const r=await fetch(ROOT+'status',{credentials:'same-origin',cache:'no-store',
        signal,headers:{Accept:'application/json'}});
      const j=await r.json();
      if(!r.ok||j.schema!=='QSYN-INDEX-WEB-OPERATIONS/1')
        throw Error(j.error||'INDEX_WEB_STATUS_UNAVAILABLE');
      setStatus(j);setError('');
    }catch(e){
      if(!signal?.aborted){setStatus(null);setError(
        /^[a-z0-9_]{3,80}$/i.test(e.message||'')?e.message:'INDEX_WEB_STATUS_UNAVAILABLE');}
    }
  },[]);
  useEffect(()=>{
    const c=new AbortController();void reload(c.signal);
    return ()=>c.abort();
  },[reload]);
  async function execute(action,service=null){
    if(busy||!status?.csrf)return;
    if((action==='start'||action==='stop'||action==='backfill') &&
       !window.confirm(action==='backfill'
         ? 'Import the approved index allowlist for '+date+'? This may require several consecutive requests.'
         : 'Confirm '+action+' the approved private index '+service+' service?'))
       return;
    setBusy(true);setError('');setReport(null);
    const submit=async(body)=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),30000);
      try{
        const r=await fetch(ROOT+action,{
          method:'POST',credentials:'same-origin',cache:'no-store',
          signal:controller.signal,
          headers:{'Content-Type':'application/json','Accept':'application/json',
            'X-CSRF-Token':status.csrf},
          body:JSON.stringify(body)
        });
        const j=await r.json();
        if(!r.ok)throw Error(j.error||'INDEX_OPERATION_DENIED');
        if(j.schema!=='QSYN-INDEX-WEB-OPERATIONS/1')
          throw Error('INDEX_RESPONSE_INVALID');
        return j;
      }finally{clearTimeout(timer);}
    };
    try{
      if(action==='backfill'){
        let approved=null,step=0,candles=0;
        do{
          const j=await submit({confirmed:true,date,step});
          if(j.result_code!=='INDEX_HISTORY_STEP_COMPLETED' ||
              j.step!==step||j.next_step!==step+1 ||
              !Number.isInteger(j.approved_instrument_count) ||
              j.approved_instrument_count<1||j.approved_instrument_count>8 ||
              (approved!==null&&approved!==j.approved_instrument_count) ||
              !Number.isInteger(j.candle_count)||j.candle_count<0)
            throw Error('INDEX_STEP_RESPONSE_INVALID');
          approved=j.approved_instrument_count;
          candles+=j.candle_count;step=j.next_step;
          setReport({action,code:'INDEX_IMPORT_IN_PROGRESS',
            approved,processed:step,candles});
        }while(step<approved);
        setReport({action,code:'INDEX_HISTORY_BATCH_COMPLETED',
          approved,processed:step,candles});
      }else{
        const j=await submit({confirmed:true,date,...(service?{service}:{})});
        setReport({action,code:j.result_code,approved:j.approved_instrument_count,
          processed:j.processed_instrument_count,service:j.service});
      }
      await reload();
    }catch(e){
      setError(e.name==='AbortError'?'INDEX_OPERATION_TIMED_OUT':
        /^[a-z0-9_]{3,90}$/i.test(e.message||'')?e.message:'INDEX_OPERATION_FAILED');
    }finally{setBusy(false);}
  }
  const available=Boolean(status?.preflight_enabled &&
    status?.private_plan_ready && status?.archive_ready && status?.rust_binary_ready);
  return <section className="terminal-surface" aria-label="Indian index web operations">
    <div className="terminal-card-head"><h2>Indian indices · web operations</h2>
      <ShieldCheck size={18}/></div>
    <p>Run the existing Rust index checks and authorized historical backfill from
      QSYN, without console commands. The server must first have an approved
      private plan, instrument permissions and bounded execution rights.</p>
    {status?<div className="qt-market-status-grid">
      <div><small>Private worker plan</small><strong>{status.private_plan_ready?'Present · not validated':'Not provisioned'}</strong></div>
      <div><small>Index history storage</small><strong>{status.archive_ready?'Private directory ready':'Unavailable'}</strong></div>
      <div><small>Web operator</small><strong>{status.web_operations_enabled?'Imports and service actions approved':status.preflight_enabled?'Read-only checks available':'Private setup required'}</strong></div>
      <div><small>Live data</small><strong>Not verified</strong></div>
    </div>:<p role="status">Operations unavailable or administrator login required.</p>}
    <div className="qt-form qt-index-web-form">
      <label>Historical trading date (IST)
        <input aria-label="Index historical trading date" type="date" value={date}
          max={lastCompletedIst()} onChange={e=>setDate(e.target.value)}/>
      </label>
      <div className="qt-actions">
        <button className="terminal-action terminal-secondary-action" type="button"
          onClick={()=>void reload()} disabled={busy}>
          <RefreshCw size={16}/> Refresh readiness</button>
        <button className="terminal-action terminal-secondary-action" type="button"
          disabled={busy||!available} onClick={()=>void execute('check')}>
          Validate six-index plan</button>
        <button className="terminal-action" type="button"
          disabled={busy||!available||!status?.web_operations_enabled||!status?.backfill_enabled}
          onClick={()=>void execute('backfill')}>
          Import approved historical candles</button>
      </div>
    </div>
    <div className="qt-actions">
      {['worker','history'].map(name=><React.Fragment key={name}>
        <span>{name==='worker'?'Live index worker':'Private history reader'}:
          {' '}{status?.services?.[name]||'not checked'}</span>
        {['start','stop'].map(action=><button type="button"
          className="terminal-action terminal-secondary-action" key={action}
          disabled={busy||!available||!status?.web_operations_enabled||!status?.service_controls_enabled}
          onClick={()=>void execute(action,name)}>
          {action==='start'?'Start':'Stop'} {name==='worker'?'worker':'reader'}
        </button>)}
      </React.Fragment>)}
    </div>
    {report&&<p role="status" className="terminal-footnote">
      {report.code} · {report.approved!==undefined?'Approved instruments: '+report.approved+' · ':''}
      {report.processed!==undefined?'Processed: '+report.processed+' · ':''}
      {report.candles!==undefined?'Candles returned: '+report.candles+' · ':''}
      {report.service?'Service: '+report.service+' · ':''}
      A successful command does not prove an active exchange feed.</p>}
    {error&&<p role="alert">Index operation unavailable: {error}</p>}
    <p className="terminal-footnote"><LockKeyhole size={13} aria-hidden="true"/>
      {' '}Buttons are disabled unless Cloudways explicitly provisions the private
      executable, plan, historical archive, and operation permissions. No tokens,
      arbitrary paths, trading orders or shell commands are accepted from the browser.
      Starting a service does not bypass exchange data rights or activate public redistribution.</p>
  </section>;
}

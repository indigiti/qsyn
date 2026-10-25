/** QSYN operational landing: evidence first, never fabricated market prices. */
import React,{useEffect,useState} from 'react';
import {Activity,ArrowRight,CandlestickChart,Database,Radio,RefreshCw,
  ShieldCheck,Wallet} from 'lucide-react';
import {LiveFeedSwitch,useLiveFeedPreference} from './live-feed-switch.jsx';
import {fetchDashboardStatus} from './dashboard-status.js';
import './dashboard.css';

const EMPTY={account:'unavailable',catalog:'unavailable',counts:null,
  importDay:null,today:false,live:'unavailable'};
function Destination({icon:Icon,title,detail,onClick}){
  return <button type="button" className="qd-destination" onClick={onClick}>
    <Icon size={19} aria-hidden="true"/>
    <span><strong>{title}</strong><small>{detail}</small></span>
    <ArrowRight size={16} aria-hidden="true"/>
  </button>;
}
function Metric({label,value,detail,state='neutral',children}){
  return <section className="qd-panel qd-metric">
    <h2>{label}</h2>
    <strong className={'qd-value qd-value-'+state}>{value}</strong>
    {detail&&<p className="qd-description">{detail}</p>}
    {children}
  </section>;
}
export function DashboardCockpit({openView}){
  const enabled=useLiveFeedPreference();
  const [summary,setSummary]=useState(EMPTY);
  const [revision,setRevision]=useState(0);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);
    void fetchDashboardStatus({signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted)setSummary(value);
    }).catch(()=>{
      if(!controller.signal.aborted)setSummary(EMPTY);
    }).finally(()=>{
      if(!controller.signal.aborted)setLoading(false);
    });
    return ()=>controller.abort();
  },[revision]);
  const status=loading?'Checking…':summary;
  const accountValue=loading?'Checking…':
    summary.account==='stored'?'Token stored':
    summary.account==='missing'?'Not configured':'Check unavailable';
  const catalogValue=loading?'Checking…':
    summary.catalog==='ready'?'Imported':
    summary.catalog==='missing'?'Import required':'Check unavailable';
  const catalogText=summary.catalog==='ready'
    ?'NSE '+summary.counts.NSE.toLocaleString()+' · BSE '+
      summary.counts.BSE.toLocaleString()+' instruments · '+summary.importDay+
      (summary.today?'':' · refresh recommended')
    :summary.catalog==='missing'
      ?'The operator must import the official NSE/BSE master files on the server.'
      :'Private master-list status could not be verified.';
  const liveValue=loading?'Checking…':
    summary.live==='verified'?'Verified':
    summary.live==='unverified'?'Not verified':'Check unavailable';
  return <div className="terminal-page qd-dashboard">
    <header className="qd-heading">
      <div><p className="terminal-eyebrow">QSYN / TERMINAL</p>
        <h1>Dashboard</h1>
        <p>Market access and read-only operational status.</p>
      </div>
      <div className="qd-heading-actions">
        <span className="qd-safety"><ShieldCheck size={14} aria-hidden="true"/>
          READ ONLY · ORDERS DISABLED</span>
        <button type="button" className="qd-refresh" disabled={loading}
          aria-label="Refresh dashboard status"
          onClick={()=>setRevision(n=>n+1)}>
          <RefreshCw size={15} aria-hidden="true"/> {loading?'Checking…':'Refresh status'}
        </button>
      </div>
    </header>
    <section className="qd-overview" aria-label="QSYN operational status">
      <section className="qd-panel qd-metric qd-feed" aria-label="Live feed control">
        <h2><Radio size={16} aria-hidden="true"/> Live chart feed</h2>
        <LiveFeedSwitch ariaLabel="Live market data feed"/>
        <p className="qd-description">{enabled
          ? 'Subscriptions allowed in this browser. This is not proof of a live connection.'
          : 'Live subscriptions paused. Historical charts are not disabled.'}</p>
      </section>
      <Metric label="Upstox account" value={accountValue}
        state={!loading&&summary.account==='stored'?'ready':'neutral'}
        detail={summary.account==='stored'
          ?'Read-only Analytics Token stored; provider authorization is not confirmed.'
          :'Check broker connections for account and token setup.'}>
        <button className="qd-inline-action" type="button" onClick={()=>openView('brokers')}>
          Data providers <ArrowRight size={14} aria-hidden="true"/>
        </button>
      </Metric>
      <Metric label="NSE / BSE symbol masters" value={catalogValue}
        state={!loading&&summary.catalog==='ready'?'ready':'neutral'}
        detail={loading?'Checking private master-list import…':catalogText}>
        <button className="qd-inline-action" type="button" onClick={()=>openView('markets')}>
          Open Markets <ArrowRight size={14} aria-hidden="true"/>
        </button>
      </Metric>
      <Metric label="Index live data" value={liveValue}
        state={!loading&&summary.live==='verified'?'ready':'neutral'}
        detail="Live index-data verification is separate from the browser feed switch and saved broker token.">
        <button className="qd-inline-action" type="button" onClick={()=>openView('diagnostics')}>
          Feed diagnostics <ArrowRight size={14} aria-hidden="true"/>
        </button>
      </Metric>
    </section>
    <section className="qd-navigation" aria-label="Quick access">
      <div className="qd-section-heading">
        <h2>Quick access</h2><p>Open the existing terminal workspace.</p>
      </div>
      <div className="qd-destinations">
        <Destination icon={CandlestickChart} title="Markets"
          detail="Charts, instrument masters and historical data"
          onClick={()=>openView('markets')}/>
        <Destination icon={Wallet} title="Data providers"
          detail="Upstox authentication and feed connections"
          onClick={()=>openView('brokers')}/>
        <Destination icon={Activity} title="Diagnostics"
          detail="Service checks and failure reports"
          onClick={()=>openView('diagnostics')}/>
      </div>
    </section>
    <nav className="qd-secondary" aria-label="Secondary research workspaces">
      <span>Research tools</span>
      <button type="button" onClick={()=>openView('strategy')}>Strategy Studio (simulation)</button>
      <button type="button" onClick={()=>openView('workspaces')}>Saved chart workspaces</button>
    </nav>
  </div>;
}

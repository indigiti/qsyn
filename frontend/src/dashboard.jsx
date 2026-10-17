/**
 * Compact operational overview for QSYN's protected terminal. A browser
 * toggle is not proof of a connected or licensed provider. Trading is off.
 */
import React,{useMemo} from 'react';
import {Activity,ArrowRight,ArrowUpRight,CandlestickChart,Clock3,
  Database,Layers3,LockKeyhole,Radio,ShieldCheck,Wallet,Workflow} from 'lucide-react';
import {loadBrowserWorkspace} from './terminal-workspace.js';
import {LiveFeedSwitch,useLiveFeedPreference} from './live-feed-switch.jsx';
import './dashboard.css';

const PRIMARY_PANE=Object.freeze({id:'primary',symbol:'QSYN-NIFTY-STRADDLE'});
const NOOP=()=>{};

function OverviewCard({icon:Icon,title,value,detail,children}){
  return <section className="qd-overview-card">
    <div className="qd-overview-label"><Icon size={16}/><span>{title}</span></div>
    {value&&<strong>{value}</strong>}
    {detail&&<small>{detail}</small>}
    {children}
  </section>;
}
function QuickAction({icon:Icon,title,detail,onClick}){
  return <button type="button" className="qd-quick-action" onClick={onClick}>
    <Icon size={19}/><span><strong>{title}</strong><small>{detail}</small></span>
    <ArrowRight size={16}/>
  </button>;
}

export function DashboardCockpit({capabilities,openView,theme,ChartPanel}){
  const workspace=useMemo(()=>{
    let local=null;
    try{local=window.localStorage;}catch{}
    return loadBrowserWorkspace(local);
  },[]);
  const liveEnabled=useLiveFeedPreference();
  const simulationSafe=capabilities?.market_data==='simulated'&&
    capabilities?.execution_enabled===false&&capabilities?.live_trading_enabled===false;
  return <div className="terminal-page qd-dashboard">
    <header className="qd-page-heading">
      <div>
        <p className="terminal-eyebrow">TERMINAL / OVERVIEW</p>
        <h1>Command center</h1>
        <p>Market-data controls, source verification and chart access in one place.</p>
      </div>
      <span className="qd-readonly"><ShieldCheck size={15}/> READ ONLY · ORDERS DISABLED</span>
    </header>

    <div className="qd-overview" aria-label="Terminal operational overview">
      <OverviewCard icon={Radio} title="Live chart feed">
        <LiveFeedSwitch ariaLabel="Live market data feed"/>
      </OverviewCard>
      <OverviewCard icon={Activity} title="Source health" value="Check provider"
        detail="Enabled updates do not confirm connectivity.">
        <button type="button" className="qd-inline-link"
          onClick={()=>openView('diagnostics')}>View diagnostics <ArrowUpRight size={14}/></button>
      </OverviewCard>
      <OverviewCard icon={Database} title="Historical candles" value="Per instrument"
        detail="Verify actual provider coverage in Markets.">
        <button type="button" className="qd-inline-link"
          onClick={()=>openView('markets')}>Open data charts <ArrowUpRight size={14}/></button>
      </OverviewCard>
      <OverviewCard icon={LockKeyhole} title="Order execution" value="Disabled"
        detail="Live market-data controls cannot enable trading."/>
    </div>

    {!liveEnabled&&<div className="qd-paused-banner" role="status">
      <Radio size={16}/> Live chart subscriptions are paused in this browser.
      Historical candles and saved workspaces remain available.
    </div>}

    <div className="qd-dashboard-grid">
      <section className="qd-surface qd-quick-links" aria-label="Quick terminal actions">
        <div className="qd-section-heading"><div><p className="qd-eyebrow">QUICK ACTIONS</p>
          <h2>Open workspace</h2></div><Layers3 size={18}/></div>
        <div className="qd-action-list">
          <QuickAction icon={CandlestickChart} title="Markets"
            detail="Live crypto, licensed indices and native charts"
            onClick={()=>openView('markets')}/>
          <QuickAction icon={Wallet} title="Data providers"
            detail="Upstox credentials and source connections"
            onClick={()=>openView('brokers')}/>
          <QuickAction icon={Activity} title="Diagnostics"
            detail="Read-only source health and secure audit"
            onClick={()=>openView('diagnostics')}/>
          <QuickAction icon={Workflow} title="Strategy Studio"
            detail="Simulated CE/PE research only"
            onClick={()=>openView('strategy')}/>
        </div>
      </section>

      <section className="qd-surface qd-feed-operations" aria-label="Feed operation guidance">
        <div className="qd-section-heading"><div><p className="qd-eyebrow">MARKET DATA</p>
          <h2>Feed & source overview</h2></div><Clock3 size={18}/></div>
        <div className="qd-fact-row"><span>Browser subscriptions</span>
          <strong>{liveEnabled?'Enabled':'Paused'}</strong></div>
        <div className="qd-fact-row"><span>Provider connection</span>
          <strong>Verify in Markets</strong></div>
        <div className="qd-fact-row"><span>Index authorization</span>
          <strong>Owner access required</strong></div>
        <div className="qd-fact-row"><span>Previous-session history</span>
          <strong>Per chart</strong></div>
        <p className="qd-assurance"><ShieldCheck size={15}/>
          The switch stops this browser's live subscriptions, not the shared Rust service,
          stored candles or authorization controls.</p>
        <button type="button" className="qd-section-link" onClick={()=>openView('markets')}>
          Verify a market source <ArrowRight size={16}/></button>
      </section>
    </div>

    <section className="qd-surface qd-chart-preview" aria-label="Synthetic market chart preview">
      <div className="qd-section-heading"><div>
        <p className="qd-eyebrow">CHART STUDIO · SIMULATION ONLY</p>
        <h2>Synthetic premium workspace</h2>
        <p>Illustrative research candles, not licensed NSE/BSE quotes.</p>
      </div>
        <button type="button" className="qd-inline-link" onClick={()=>openView('markets')}>
          Open Markets <ArrowUpRight size={16}/></button>
      </div>
      <div className="qd-chart-preview-inner">
        <ChartPanel pane={PRIMARY_PANE} theme={theme} savedState={null}
          revision={0} onMount={NOOP}/>
      </div>
    </section>
    <div className="qd-dashboard-footer">
      <span><Layers3 size={14}/> {workspace.layouts.length} browser-local layouts</span>
      <span><ShieldCheck size={14}/>
        {simulationSafe?'Demo capability verified':'Simulation availability not verified'} · No orders</span>
    </div>
  </div>;
}

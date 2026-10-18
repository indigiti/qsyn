/** Lean operational overview. The browser switch is not proof of connectivity. */
import React from 'react';
import {Activity,ArrowRight,CandlestickChart,Radio,ShieldCheck,Wallet} from 'lucide-react';
import {LiveFeedSwitch,useLiveFeedPreference} from './live-feed-switch.jsx';
import './dashboard.css';

function Destination({icon:Icon,title,detail,onClick}){
  return <button type="button" className="qd-destination" onClick={onClick}>
    <Icon size={18}/><span><strong>{title}</strong><small>{detail}</small></span><ArrowRight size={16}/>
  </button>;
}
export function DashboardCockpit({openView}){
  const enabled=useLiveFeedPreference();
  return <div className="terminal-page qd-dashboard">
    <header className="qd-heading">
      <div><p className="terminal-eyebrow">QSYN / TERMINAL</p>
        <h1>Dashboard</h1><p>Market access, live feed control, and diagnostics.</p></div>
      <span className="qd-safety"><ShieldCheck size={14}/> READ ONLY · ORDERS DISABLED</span>
    </header>
    <div className="qd-main">
      <section className="qd-panel qd-feed" aria-label="Live feed control">
        <div className="qd-panel-heading"><Radio size={17}/><h2>Live chart feed</h2></div>
        <LiveFeedSwitch ariaLabel="Live market data feed"/>
        <p className="qd-description">{enabled
          ? 'Subscriptions enabled in this browser. Check Markets for actual source connectivity.'
          : 'Subscriptions paused in this browser. Historical candles remain available.'}</p>
        <p className="qd-note">This control does not start the Rust service or authorize live orders.</p>
      </section>
      <section className="qd-panel" aria-label="Main terminal destinations">
        <h2>Open</h2>
        <div className="qd-destinations">
          <Destination icon={CandlestickChart} title="Markets" detail="Charts and market history"
            onClick={()=>openView('markets')}/>
          <Destination icon={Wallet} title="Data providers" detail="Upstox connections and tokens"
            onClick={()=>openView('brokers')}/>
          <Destination icon={Activity} title="Diagnostics" detail="Verified source and service health"
            onClick={()=>openView('diagnostics')}/>
        </div>
      </section>
    </div>
    <nav className="qd-secondary" aria-label="Secondary research workspaces">
      <span>Optional research</span>
      <button type="button" onClick={()=>openView('strategy')}>Strategy Studio (simulation)</button>
      <button type="button" onClick={()=>openView('workspaces')}>Saved chart workspaces</button>
    </nav>
  </div>;
}

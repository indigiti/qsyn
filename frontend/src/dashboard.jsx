/**
 * QSYN dashboard cockpit: a presentation layer over the existing simulated
 * OpenAlgo Charts widget. No new trading, broker or market-data endpoints.
 */
import React, { useMemo } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, CandlestickChart, CheckCircle2,
  Clock3, Compass, FileClock, FlaskConical, Layers3, LockKeyhole,
  Radio, ShieldCheck, SlidersHorizontal, Wallet, Workflow,
} from 'lucide-react';
import { loadBrowserWorkspace, instrumentFor } from './terminal-workspace.js';
import './dashboard.css';

const PRIMARY_PANE = Object.freeze({ id: 'primary', symbol: 'QSYN-NIFTY-STRADDLE' });
const NOOP = () => {};
const DEST = '/qsyn/terminal';

function StateCard({ icon: Icon, label, value, detail, tone = 'muted' }) {
  return <section className="qd-state-card">
    <div className="qd-state-heading"><span className={'qd-state-icon ' + tone}><Icon size={16}/></span><span>{label}</span></div>
    <strong>{value}</strong><small>{detail}</small>
  </section>;
}
function FlowStep({ number, title, description, tone = '' }) {
  return <div className={'qd-flow-step ' + tone}>
    <span className="qd-flow-number">{number}</span><div><b>{title}</b><small>{description}</small></div>
  </div>;
}
function LinkTile({ title, detail, icon: Icon, onClick, href, subtle = false }) {
  const content = <><span className="qd-tile-icon"><Icon size={19}/></span>
    <span className="qd-tile-text"><strong>{title}</strong><small>{detail}</small></span>
    <ArrowUpRight size={17} className="qd-tile-arrow" /></>;
  const name = 'qd-link-tile' + (subtle ? ' subdued' : '');
  return href
    ? <a href={href} className={name}>{content}</a>
    : <button type="button" className={name} onClick={onClick}>{content}</button>;
}

export function DashboardCockpit({ capabilities, openView, theme, ChartPanel }) {
  // Only unscoped, simulated watchlist/layout metadata belongs in this panel.
  // Private authenticated workspaces must never be loaded into this UI.
  const workspace = useMemo(() => {
    let local = null;
    try { local = window.localStorage; } catch {}
    return loadBrowserWorkspace(local);
  }, []);
  const simulatedContract = capabilities?.market_data === 'simulated' &&
    capabilities?.execution_enabled === false &&
    capabilities?.live_trading_enabled === false;
  const sourceDescription = simulatedContract
    ? 'Demo capability contract confirmed'
    : 'Feed capability not verified';
  const previewWatchlist = workspace.watchlist.slice(0, 3);

  return <div className="terminal-page qd-dashboard">
    <header className="qd-page-heading">
      <div>
        <p className="terminal-eyebrow">QSYN / WORKSPACE OVERVIEW</p>
        <h1>Command center<span className="qd-heading-dot">.</span></h1>
        <p>Charts, strategy research, and system readiness in one workspace.</p>
      </div>
      <span className="qd-mode-indicator"><span className="qd-mode-circle"/> SIMULATION ONLY</span>
    </header>

    <div className="qd-hero">
      <div className="qd-hero-copy">
        <div className="qd-hero-kicker"><Activity size={15}/> YOUR TRADING WORKSPACE</div>
        <h2>Everything in view.<br/><span>Nothing left to guess.</span></h2>
        <p>Explore synthetic CE/PE strategies using simulated data. Broker authorization and live execution remain separately gated.</p>
        <div className="qd-hero-actions">
          <button type="button" className="qd-primary-button" onClick={() => openView('trading')}>
            Open chart terminal <ArrowRight size={16}/>
          </button>
          <button type="button" className="qd-ghost-button" onClick={()=>openView('strategy')}>Explore strategy lab <ArrowUpRight size={16}/></button>
        </div>
      </div>
      <div className="qd-hero-graphic" aria-hidden="true">
        <div className="qd-orbit qd-orbit-one"/><div className="qd-orbit qd-orbit-two"/>
        <span className="qd-graphic-label top">CE LEG <span>+</span></span>
        <span className="qd-graphic-letter">Q</span>
        <span className="qd-graphic-label bottom">PE LEG <span>+</span></span>
      </div>
    </div>

    <div className="qd-states" aria-label="Workspace status">
      <StateCard icon={Radio} label="Market data" value="Simulated" detail={sourceDescription} tone="blue"/>
      <StateCard icon={Wallet} label="Broker account" value="Not connected" detail="No active authorized session"/>
      <StateCard icon={LockKeyhole} label="Order execution" value="Disabled" detail="Trading approval required" tone="amber"/>
      <StateCard icon={Layers3} label="Saved workspaces" value={String(workspace.layouts.length)}
        detail="Browser-local chart layouts" tone="purple"/>
    </div>

    <div className="qd-main-grid">
      <section className="qd-featured-chart" aria-label="Synthetic market chart preview">
        <div className="qd-section-header">
          <div><div className="qd-overline">CHART STUDIO / PREVIEW</div><h2>Synthetic premium workspace</h2></div>
          <button type="button" className="qd-text-action" onClick={() => openView('trading')}>
            Full charts <ArrowUpRight size={16}/>
          </button>
        </div>
        <div className="qd-chart-preview">
          <ChartPanel pane={PRIMARY_PANE} theme={theme} savedState={null} revision={0} onMount={NOOP}/>
        </div>
      </section>

      <aside className="qd-right-column">
        <section className="qd-surface qd-workflow" aria-label="CE PE strategy workflow">
          <div className="qd-section-header">
            <div><div className="qd-overline">STRATEGY BUILDER</div><h2>From legs to insight</h2></div>
            <Workflow size={18}/>
          </div>
          <p className="qd-soft-copy">A connected research flow, inspired by the workflow reference. Values are illustrative, not exchange quotes.</p>
          <div className="qd-flow">
            <FlowStep number="01" title="Select CE + PE legs" description="NIFTY / BANKNIFTY / FINNIFTY"/>
            <FlowStep number="02" title="Compose synthetic premium" description="Aligned simulated candles"/>
            <FlowStep number="03" title="Explore payoff and risk" description="Greeks, scenarios, and replay" tone="last"/>
          </div>
          <button type="button" className="qd-wide-link" onClick={()=>openView('strategy')}>Launch Strategy Studio <ArrowRight size={16}/></button>
        </section>

        <section className="qd-surface qd-security" aria-label="Safety and execution readiness">
          <div className="qd-section-header"><div><div className="qd-overline">OPERATIONS</div><h2>Execution safeguards</h2></div><ShieldCheck size={19}/></div>
          <div className="qd-safety-row"><span><CheckCircle2 size={16}/> Simulated analytics</span><b>Available</b></div>
          <div className="qd-safety-row"><span><Clock3 size={16}/> Private CE/PE authorization</span><b>Gated</b></div>
          <div className="qd-safety-row"><span><LockKeyhole size={16}/> Real-money order routing</span><b>Locked</b></div>
          <button type="button" className="qd-text-action" onClick={() => openView('private-live')}>
            View restricted charts <ArrowUpRight size={16}/>
          </button>
        </section>
      </aside>
    </div>

    <div className="qd-bottom-grid">
      <section className="qd-surface qd-shortcuts">
        <div className="qd-section-header"><div><div className="qd-overline">NAVIGATION</div><h2>Go to workspace</h2></div><Compass size={18}/></div>
        <div className="qd-links-grid">
          <LinkTile title="OpenAlgo Charts" detail="Candles, studies, drawings" icon={CandlestickChart} onClick={() => openView('trading')}/>
          <LinkTile title="Strategy Studio" detail="Simulated CE/PE and payoff" icon={FlaskConical} onClick={()=>openView('strategy')}/>
          <LinkTile title="Analytics tools" detail="Explore available features" icon={SlidersHorizontal} onClick={() => openView('tools')}/>
          <LinkTile title="Private market view" detail="Requires authorized access" icon={LockKeyhole} onClick={() => openView('private-live')} subtle/>
        </div>
      </section>
      <section className="qd-surface qd-watchlist" aria-label="Browser watchlist preview">
        <div className="qd-section-header"><div><div className="qd-overline">LOCAL WORKSPACE</div><h2>Watchlist</h2></div><span className="qd-small-count">{workspace.watchlist.length} saved</span></div>
        <p className="qd-soft-copy">Only simulated instruments saved in this browser.</p>
        {previewWatchlist.length
          ? previewWatchlist.map(id => <div className="qd-watch-row" key={id}>
              <span className="qd-symbol-icon"><Activity size={15}/></span>
              <span><strong>{instrumentFor(id)?.underlying || 'QSYN DEMO'}</strong><small>{id}</small></span>
              <span className="qd-watch-badge">SIM</span>
            </div>)
          : <p className="qd-empty-watchlist">No simulated instruments saved.</p>}
        <button type="button" className="qd-text-action" onClick={() => openView('trading')}>Manage chart watchlist <ArrowRight size={15}/></button>
      </section>
    </div>

    <footer className="qd-footer"><FileClock size={15}/>
      Dashboard is a simulated research workspace. No account balances, market P&amp;L, live ticks, or executable orders are presented.
    </footer>
  </div>;
}

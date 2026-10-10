/**
 * QSYN native-style terminal shell.
 *
 * Navigation hierarchy and design-language adapted from OpenAlgo React
 * frontend/src/config/navigation.ts, frontend/src/components/layout/Navbar.tsx
 * at pin 12e1114657981a3e50dde8c8ce04eb778ae1cf2f (AGPL-3.0).
 * This is an independent, explicitly scoped QSYN React shell, NOT a claim that
 * upstream Flask-backed account/trading pages have been ported.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, BookOpen, CandlestickChart, ChartColumnIncreasing, ChevronDown,
  ClipboardList, Compass, FlaskConical, Gauge, Layers, LayoutDashboard,
  LockKeyhole, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search,
  Settings, ShieldAlert, Sun, Wallet, Wrench, X,
} from 'lucide-react';
import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';
import { QsynDemoFeed } from './rust-demo-feed.js';
import './terminal.css';

const BASE = '/qsyn/terminal';
const VIEWS = new Set(['dashboard', 'trading', 'tools']);
const sections = [
  { label: 'Dashboard', view: 'dashboard', icon: LayoutDashboard },
  { label: 'Trading', view: 'trading', icon: CandlestickChart },
  { label: 'Tools', view: 'tools', icon: Wrench },
];
const unavailable = [
  { label: 'Orderbook', icon: ClipboardList },
  { label: 'Positions', icon: ChartColumnIncreasing },
  { label: 'Broker accounts', icon: Wallet },
];
function routeView() {
  const url = new URL(window.location.href);
  const proposed = url.searchParams.get('view');
  return VIEWS.has(proposed) ? proposed : 'trading';
}
function currentTheme() {
  try { return localStorage.getItem('qsyn-terminal-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
function ChartPanel({ theme }) {
  const [message, setMessage] = useState('Loading demonstrative candles…');
  const [problem, setProblem] = useState('');
  const containerId = 'qsyn-native-chart';
  useEffect(() => {
    const root = document.getElementById(containerId);
    if (!root) return;
    const feed = new QsynDemoFeed(setMessage);
    // Never enable the diagnostic polling stream. This is historical SIM data.
    let widget;
    try {
      widget = createWidget(root, {
        feed, symbol: 'QSYN-DEMO', exchange: 'QSYN',
        interval: '1m', theme, persist: 'qsyn-native-demo-v1',
        navigation: { defaultVisibleBars: 95, mousePan: 'horizontal' },
      });
      widget.ready.then(() => setMessage('120 simulated 1-minute candles · PHP file-free sample API'))
        .catch(() => setProblem('The chart could not load. No broker data was requested.'));
    } catch {
      setProblem('OpenAlgo Charts is unavailable. No broker data was requested.');
    }
    return () => {
      // React StrictMode and navigation must never leave orphan chart listeners.
      try { widget?.destroy(); } catch {}
      feed.stopSubscription();
      feed.setEnabled(false);
    };
  }, [theme]);
  return (
    <section className="terminal-chart-card" aria-label="OpenAlgo Charts candlestick terminal">
      <div className="terminal-card-head">
        <div>
          <div className="terminal-eyebrow">OPENALGO CHARTS · QSYN ADAPTER</div>
          <h2>QSYN-DEMO <small>· 1m · SIMULATED</small></h2>
        </div>
        <span className="terminal-chip">No live orders</span>
      </div>
      <div id={containerId} className="terminal-chart-host" aria-label="Simulated candlestick chart" />
      {problem ? <p role="alert" className="terminal-error">{problem}</p> :
        <p className="terminal-footnote" role="status">{message}</p>}
    </section>
  );
}
function StatusBox({ capabilities }) {
  const simulated = !capabilities || capabilities.market_data !== 'simulated' ||
    capabilities.execution_enabled !== false || capabilities.live_trading_enabled !== false;
  return (
    <section className="terminal-surface terminal-status" aria-label="Market source and execution status">
      <div className="terminal-card-head"><h2>Connection overview</h2><Activity size={17} /></div>
      <dl>
        <div><dt>Data source</dt><dd>SIMULATED</dd></div>
        <div><dt>Broker session</dt><dd>Not connected</dd></div>
        <div><dt>Execution</dt><dd>Disabled</dd></div>
        <div><dt>Persistence</dt><dd>QSYN file-based design</dd></div>
      </dl>
      <p className="terminal-footnote">{simulated
        ? 'Live capabilities have not been verified; all trading is blocked.'
        : 'Simulation only. No exchange quote redistribution or real orders.'}</p>
    </section>
  );
}
function Dashboard({ capabilities, openView }) {
  return (
    <div className="terminal-page">
      <header className="terminal-title"><div><p className="terminal-eyebrow">WORKSPACE OVERVIEW</p>
        <h1>Dashboard</h1><p>OpenAlgo-inspired navigation with QSYN-owned, database-free services.</p>
      </div><button className="terminal-action" onClick={() => openView('trading')}>Open charts <CandlestickChart size={16}/></button></header>
      <div className="terminal-overview">
        <StatusBox capabilities={capabilities} />
        <section className="terminal-surface"><div className="terminal-card-head"><h2>Quick access</h2><Compass size={17}/></div>
          <a className="terminal-quick" href={BASE + '?view=trading'}>Trading charts <CandlestickChart size={18}/></a>
          <a className="terminal-quick" href="/qsyn/studio">Synthetic Studio <Layers size={18}/></a>
          <a className="terminal-quick" href={BASE + '?view=tools'}>Tools & integrations <Wrench size={18}/></a>
        </section>
      </div>
      <section className="terminal-surface">
        <div className="terminal-card-head"><h2>Enabled capabilities</h2><ShieldAlert size={18}/></div>
        <div className="terminal-capabilities">
          <span>OpenAlgo Charts widgets and indicators</span><span>Simulated</span>
          <span>CE/PE Synthetic Studio</span><a href="/qsyn/studio">Open</a>
          <span>Broker-linked account trading</span><span>Disabled</span>
          <span>Durable account OMS</span><span>Not public</span>
        </div>
      </section>
    </div>
  );
}
function Tools() {
  return (
    <div className="terminal-page">
      <header className="terminal-title"><div><p className="terminal-eyebrow">ANALYTICS</p>
        <h1>Tools</h1><p>Tools are enabled only when their QSYN backend contracts exist.</p>
      </div></header>
      <div className="terminal-tool-grid">
        <a className="terminal-tool" href="/qsyn/studio"><Layers /><h2>Synthetic Studio</h2><p>Simulated CE/PE legs, combined premiums, risk and replay.</p><span>Open studio →</span></a>
        <a className="terminal-tool" href={BASE + '?view=trading'}><CandlestickChart /><h2>Chart terminal</h2><p>Upstream OpenAlgo Charts widget, indicators and drawings.</p><span>Open chart →</span></a>
        <div className="terminal-tool unavailable"><LockKeyhole /><h2>Live option chain</h2><p>Requires a licensed, authenticated account-scoped feed.</p><span>Unavailable</span></div>
        <div className="terminal-tool unavailable"><Gauge /><h2>Order management</h2><p>Requires production permissions and execution risk approval.</p><span>Unavailable</span></div>
      </div>
    </div>
  );
}
function App() {
  const [view, setView] = useState(routeView);
  const [theme, setTheme] = useState(currentTheme);
  const [sidebar, setSidebar] = useState(false);
  const [capabilities, setCapabilities] = useState(null);
  useEffect(() => {
    const change = () => setView(routeView());
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-qsyn-theme', theme);
    try { localStorage.setItem('qsyn-terminal-theme', theme); } catch {}
  }, [theme]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetch('/qsyn/api/v1/studio/capabilities', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    }).then(response => { if (!response.ok) throw Error('capabilities unavailable'); return response.json(); })
      .then(data => { if (active) setCapabilities(data); })
      .catch(() => { if (active) setCapabilities(null); });
    return () => { active = false; controller.abort(); };
  }, []);
  const current = useMemo(() => sections.find(s => s.view === view) || sections[1], [view]);
  function openView(next) {
    if (!VIEWS.has(next)) return;
    window.history.pushState(null, '', BASE + '?view=' + next);
    setView(next);
    setSidebar(false);
  }
  function Navigation({ mobile = false }) {
    return <nav aria-label={mobile ? 'Mobile terminal' : 'Terminal'}>
      <p className="terminal-nav-label">Workspace</p>
      {sections.map(s => <button key={s.view} type="button"
        aria-current={view === s.view ? 'page' : undefined}
        className={'terminal-nav-item' + (view === s.view ? ' active' : '')}
        onClick={() => openView(s.view)}><s.icon size={18}/><span>{s.label}</span></button>)}
      <a className="terminal-nav-item" href="/qsyn/studio"><Layers size={18}/><span>Synthetic Studio</span></a>
      <p className="terminal-nav-label">Broker services</p>
      {unavailable.map(s => <button type="button" key={s.label} disabled
        className="terminal-nav-item locked" title="Requires authenticated QSYN backend">
        <s.icon size={18}/><span>{s.label}</span><LockKeyhole size={13}/></button>)}
    </nav>;
  }
  return <div className="terminal-shell">
    <header className="terminal-topbar">
      <div className="terminal-top-left">
        <button className="terminal-icon terminal-mobile-menu" type="button" onClick={() => setSidebar(!sidebar)}
          aria-expanded={sidebar} aria-label={sidebar ? 'Close menu' : 'Open menu'}><Menu size={20}/></button>
        <div className="terminal-brand"><span className="terminal-mark">Q</span><strong>QSYN</strong>
          <span className="terminal-brand-small">TERMINAL</span></div>
        <span className="terminal-top-divider"/>
        <span className="terminal-current"><current.icon size={16}/>{current.label}</span>
      </div>
      <div className="terminal-top-right">
        <span className="terminal-environment">● SIMULATED</span>
        <button type="button" className="terminal-icon" aria-label="Toggle theme"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button>
        <a className="terminal-icon" href="/qsyn/admin/rust" aria-label="Administrator diagnostics" title="Restricted administrator diagnostics"><Settings size={17}/></a>
      </div>
    </header>
    <aside className={'terminal-sidebar' + (sidebar ? ' show' : '')}>
      <div className="terminal-sidebar-inner">
        <Navigation/>
        <div className="terminal-sidebar-footer"><BookOpen size={15}/><a target="_blank" rel="noopener noreferrer"
          href="https://github.com/marketcalls/openalgo">OpenAlgo upstream</a><small>AGPL-3.0 attribution</small></div>
      </div>
    </aside>
    {sidebar && <button type="button" className="terminal-overlay" aria-label="Close navigation"
      onClick={() => setSidebar(false)} />}
    <main id="terminal-main" className="terminal-main">
      <div className="terminal-alert" role="note"><ShieldAlert size={17}/>
        <span><b>Simulation workspace.</b> No live market data, connected broker or executable orders.</span></div>
      {view === 'dashboard' && <Dashboard capabilities={capabilities} openView={openView}/>}
      {view === 'trading' && <div className="terminal-page">
        <header className="terminal-title"><div><p className="terminal-eyebrow">MARKET WORKSPACE</p><h1>Trading charts</h1>
          <p>OpenAlgo Charts 2.6.0 with QSYN's existing simulated PHP data adapter.</p></div></header>
        <ChartPanel theme={theme}/></div>}
      {view === 'tools' && <Tools/>}
    </main>
    <nav className="terminal-bottom-nav" aria-label="Mobile quick navigation">
      {sections.map(s=><button type="button" key={s.view}
        className={view === s.view ? 'active':''} aria-current={view === s.view ? 'page':undefined}
        onClick={()=>openView(s.view)}><s.icon size={18}/><span>{s.label}</span></button>)}
      <a href="/qsyn/studio"><Layers size={18}/><span>Synthetics</span></a>
    </nav>
  </div>;
}
const root = document.getElementById('qsyn-root');
if (root) createRoot(root).render(<App />);

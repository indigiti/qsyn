/**
 * QSYN native-style terminal shell.
 *
 * Navigation hierarchy and design-language adapted from OpenAlgo React
 * frontend/src/config/navigation.ts, frontend/src/components/layout/Navbar.tsx
 * at pin 12e1114657981a3e50dde8c8ce04eb778ae1cf2f (AGPL-3.0).
 * This is an independent, explicitly scoped QSYN React shell, NOT a claim that
 * upstream Flask-backed account/trading pages have been ported.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, BookOpen, CandlestickChart, ChartColumnIncreasing, ChevronDown,
  ClipboardList, Compass, FlaskConical, Gauge, Layers, LayoutDashboard,
  LockKeyhole, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search,
  Settings, ShieldAlert, Sun, Wallet, Wrench, X, Plus, Save, Columns2, Trash2,
} from 'lucide-react';
import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';
import { QsynWorkspaceFeed } from './terminal-feed.js';
import { PrivateAuthorizedChartFeed, validatePrivateChartScope } from './private-live-chart.js';
import { checkPrivateWorkspace, savePrivateWorkspace } from './terminal-file-sync.js';
import {
  SYMBOLS, DEFAULT_PANES, instrumentFor, searchInstruments, loadBrowserWorkspace,
  storeBrowserWorkspace, saveNamedLayout, normalizeWorkspace,
} from './terminal-workspace.js';
import './terminal.css';

const BASE = '/qsyn/terminal';
const VIEWS = new Set(['dashboard', 'trading', 'tools', 'private-live']);
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
function ChartPanel({ pane, theme, savedState, revision, onMount }) {
  const host = useRef(null);
  const [message, setMessage] = useState('Loading simulated candles…');
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    const feed = new QsynWorkspaceFeed(text => { if (alive) setMessage(text); });
    let widget = null;
    setProblem('');
    try {
      widget = createWidget(host.current, {
        feed, symbol: pane.symbol, exchange: 'QSYN', interval: '1m',
        intervals: ['1m'], theme, persist: false, panels: true,
        navigation: { defaultVisibleBars: 95, mousePan: 'horizontal' },
      });
      onMount(pane.id, widget);
      widget.ready.then(() => {
        if (!alive) return;
        if (savedState && savedState.symbol === pane.symbol &&
            savedState.exchange === 'QSYN' && savedState.interval === '1m') {
          try { widget.restoreState(savedState); } catch { /* leave chart usable */ }
        }
        setMessage('Simulated 1-minute candles · no licensed exchange feed');
      }).catch(() => {
        if (alive) setProblem('The demo chart could not load. No broker connection was requested.');
      });
    } catch {
      setProblem('OpenAlgo Charts is unavailable. No broker connection was requested.');
    }
    return () => {
      alive = false;
      onMount(pane.id, null);
      try { widget?.destroy(); } catch {}
      feed.destroy();
    };
  }, [pane.id, pane.symbol, theme, revision, onMount]);
  const definition = instrumentFor(pane.symbol);
  return (
    <section className="terminal-chart-card" aria-label={pane.id === 'primary' ? 'Primary candlestick chart' : 'Comparison candlestick chart'}>
      <div className="terminal-card-head">
        <div><div className="terminal-eyebrow">OPENALGO CHARTS · SIMULATED QSYN FEED</div>
          <h2>{definition?.label || pane.symbol} <small>· 1m · DEMO</small></h2>
        </div>
        <span className="terminal-chip">No live orders</span>
      </div>
      <div ref={host} id={pane.id === 'primary' ? 'qsyn-native-chart' : 'qsyn-secondary-chart'}
        className="terminal-chart-host" aria-label="Simulated candlestick chart" />
      {problem ? <p role="alert" className="terminal-error">{problem}</p> :
        <p className="terminal-footnote" role="status">{message}</p>}
      {definition?.kind === 'synthetic' &&
        <p className="terminal-footnote">Illustrative W1 ATM CE+PE premium basket. Strike is fixed when candles load and may re-anchor on refresh. Fictional points, not INR or market prices.</p>}
    </section>
  );
}
function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}
function ChartWorkspace({ theme }) {
  const [saved, setSaved] = useState(() => loadBrowserWorkspace(browserStorage()));
  const [scope, setScope] = useState('browser');
  const [remote, setRemote] = useState({ status: 'checking' });
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [panes, setPanes] = useState(DEFAULT_PANES);
  const [active, setActive] = useState('primary');
  const [search, setSearch] = useState('');
  const [layoutName, setLayoutName] = useState('');
  const [snapshots, setSnapshots] = useState({});
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('Watchlist and layouts stay in this browser only.');
  const chartRefs = useRef(new Map());
  useEffect(() => {
    const controller = new AbortController();
    checkPrivateWorkspace(fetch, controller.signal).then(next => {
      if (!controller.signal.aborted) setRemote(next);
    });
    return () => controller.abort();
  }, []);
  async function refreshRemote() {
    setRemoteBusy(true);
    try {
      const result = await checkPrivateWorkspace(fetch);
      setRemote(result);
      setNotice(result.status === 'ready'
        ? 'Private file status refreshed. Loading it is optional.'
        : 'Private file storage is unavailable; browser workspace remains unchanged.');
    } finally { setRemoteBusy(false); }
  }
  function loadPrivate() {
    if (remote.status !== 'ready') return;
    // Keep owner-scoped data IN MEMORY. Never save private content into the
    // shared, unscoped localStorage key, including on logout or user switch.
    setSaved(remote.workspace);
    setScope('private');
    setPanes(DEFAULT_PANES);
    setSnapshots({});
    setLayoutName('');
    setRevision(v => v + 1);
    setNotice('Private workspace loaded for this authenticated test session. Changes need explicit Save private file.');
  }
  function returnToBrowser() {
    setSaved(loadBrowserWorkspace(browserStorage()));
    setScope('browser');
    setPanes(DEFAULT_PANES);
    setSnapshots({});
    setLayoutName('');
    setRevision(v => v + 1);
    setNotice('Browser workspace restored. Private data was not copied to browser storage.');
  }
  async function savePrivate() {
    if (remote.status !== 'ready' || !remote.canWrite || remoteBusy) return;
    setRemoteBusy(true);
    try {
      const result = await savePrivateWorkspace(fetch, remote, saved);
      setRemote(result);
      setNotice('Private file saved at revision ' + result.revision + ' · development identities only.');
    } catch (error) {
      setNotice(error?.message || 'Private workspace save unavailable.');
    } finally { setRemoteBusy(false); }
  }
  const onMount = useCallback((id, widget) => {
    if (widget) chartRefs.current.set(id, widget);
    else chartRefs.current.delete(id);
  }, []);

  function write(next) {
    try {
      if (scope === 'private') {
        // Changes remain in memory until an explicit authenticated CAS write.
        setSaved(normalizeWorkspace(next));
        setNotice('Unsaved private workspace changes. Click Save private file.');
      } else {
        setSaved(storeBrowserWorkspace(browserStorage(), next));
      }
      return true;
    } catch (error) {
      setNotice(error.message);
      return false;
    }
  }
  function setSymbol(symbol) {
    if (!instrumentFor(symbol)) return;
    setPanes(current => current.map(p => p.id === active ? { ...p, symbol } : p));
    setSnapshots({});
    setNotice(symbol + ' selected · SIMULATED ONLY.');
  }
  function toggleCompare() {
    setPanes(current => current.length === 2 ? current.slice(0, 1) :
      [...current, { id: 'secondary', symbol: SYMBOLS.find(s => s.id !== current[0].symbol).id }]);
    setActive('primary');
    setSnapshots({});
  }
  function toggleWatch(symbol) {
    const has = saved.watchlist.includes(symbol);
    const watchlist = has ? saved.watchlist.filter(s => s !== symbol)
      : [...saved.watchlist, symbol];
    if (write({ ...saved, watchlist })) {
      setNotice(has ? 'Removed from browser watchlist.' : 'Added to browser watchlist.');
    }
  }
  function saveLayout() {
    const name = layoutName.trim();
    const chartStates = {};
    for (const pane of panes) {
      try {
        const state = chartRefs.current.get(pane.id)?.getState();
        if (state) chartStates[pane.id] = state;
      } catch { /* only the selected instrument/layout will be saved */ }
    }
    try {
      const next = saveNamedLayout(saved, { name, panes, chartStates });
      if (write(next) && scope === 'browser') setNotice('Layout saved in this browser. No server synchronization.');
    } catch (error) { setNotice(error.message); }
  }
  function openLayout(name) {
    const layout = saved.layouts.find(l => l.name === name);
    if (!layout) return;
    setPanes(layout.panes.map(p => ({ ...p })));
    setSnapshots(layout.chartStates);
    setActive('primary');
    setLayoutName(layout.name);
    setRevision(v => v + 1);
    setNotice('Opened ' + scope + ' layout ' + layout.name + '.');
  }
  function deleteLayout() {
    const next = saved.layouts.filter(l => l.name !== layoutName);
    if (next.length === saved.layouts.length) {
      setNotice('Select a saved layout to remove.');
      return;
    }
    if (write({ ...saved, layouts: next })) {
      setLayoutName('');
      if (scope === 'browser') setNotice('Browser layout removed.');
    }
  }
  const searchResults = searchInstruments(search);
  return <div className="terminal-workspace">
    <section className="terminal-workspace-controls terminal-surface" aria-label="Chart workspace controls">
      <div className="terminal-workspace-header">
        <div><h2>Chart workspace</h2><p>Four supported sample instruments. No real NSE/BSE symbol lookup.</p></div>
        <button type="button" className="terminal-action terminal-secondary-action" onClick={toggleCompare}>
          <Columns2 size={16}/> {panes.length === 1 ? 'Compare two charts' : 'Single chart'}
        </button>
      </div>
      <div className="terminal-layout-tools">
        <label>Layout name
          <input aria-label="Layout name" value={layoutName} maxLength={36}
            onChange={e => setLayoutName(e.target.value)} placeholder="My workspace"/>
        </label>
        <button type="button" className="terminal-action" onClick={saveLayout}><Save size={16}/> Save layout</button>
        <label>Saved layouts
          <select aria-label="Saved layouts" value={saved.layouts.some(l => l.name === layoutName) ? layoutName : ''}
            onChange={e => openLayout(e.target.value)}>
            <option value="">Select layout</option>
            {saved.layouts.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
        </label>
        <button type="button" className="terminal-icon terminal-delete-layout" aria-label="Delete saved layout"
          onClick={deleteLayout}><Trash2 size={16}/></button>
      </div>
      <div className="terminal-file-controls" aria-label="Private file workspace controls">
        <span className="terminal-file-status">
          Storage: {scope === 'private' ? 'private session memory · save manually' : 'browser only'}
          {' · '}{remote.status === 'ready' ? 'private development file available'
            : remote.status === 'login_required' ? 'test login required'
            : remote.status === 'checking' ? 'checking private storage'
            : 'private sync disabled'}
        </span>
        {remote.status === 'ready' && <>
          <button type="button" className="terminal-action terminal-secondary-action"
            onClick={loadPrivate} disabled={remoteBusy}>Load private file</button>
          {remote.canWrite && <button type="button" className="terminal-action terminal-secondary-action"
            onClick={savePrivate} disabled={remoteBusy}>Save private file</button>}
          {scope === 'private' && <button type="button" className="terminal-action terminal-secondary-action"
            onClick={returnToBrowser}>Return to browser</button>}
        </>}
        {remote.status !== 'checking' && <button type="button" className="terminal-icon"
          disabled={remoteBusy} aria-label="Refresh private file status" onClick={refreshRemote}>
          <Activity size={15}/>
        </button>}
      </div>
      <p className="terminal-footnote" role="status">{notice}</p>
    </section>
    <div className="terminal-workspace-grid">
      <div className={'terminal-chart-panes' + (panes.length === 2 ? ' compared' : '')}>
        {panes.map(p => <div key={p.id} className={'terminal-chart-pane' + (active === p.id ? ' pane-active' : '')}
          onClick={() => setActive(p.id)}>
          <div className="terminal-pane-heading">
            <strong>{p.id === 'primary' ? 'Primary chart' : 'Comparison chart'}</strong>
            <label>Instrument
              <select aria-label={p.id === 'primary' ? 'Primary instrument' : 'Comparison instrument'}
                value={p.symbol} onChange={e => { setActive(p.id); setPanes(old => old.map(x => x.id === p.id ? { ...x, symbol: e.target.value } : x)); setSnapshots({}); }}>
                {SYMBOLS.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}
              </select>
            </label>
          </div>
          <ChartPanel pane={p} theme={theme} savedState={snapshots[p.id]} revision={revision} onMount={onMount}/>
        </div>)}
      </div>
      <aside className="terminal-watchlist terminal-surface" aria-label="Browser watchlist">
        <div className="terminal-card-head"><h2>Watchlist</h2><span className="terminal-chip">{scope === 'private' ? 'Private session' : 'Browser only'}</span></div>
        <p className="terminal-footnote">Select a row to chart in the active panel. No live quotes.</p>
        <div className="terminal-watch-rows">
          {saved.watchlist.length === 0 && <p className="terminal-footnote">Your watchlist is empty.</p>}
          {saved.watchlist.map(id => <div className="terminal-watch-row" key={id}>
            <button type="button" className="terminal-watch-select" onClick={() => setSymbol(id)}>
              <strong>{id}</strong><small>SIM · {instrumentFor(id)?.kind === 'synthetic' ? 'ATM CE+PE' : 'sample OHLC'}</small>
            </button>
            <button type="button" className="terminal-icon" aria-label={'Remove ' + id + ' from watchlist'}
              onClick={() => toggleWatch(id)}><X size={14}/></button>
          </div>)}
        </div>
        <label className="terminal-search-label"><Search size={15}/> Find simulated instruments
          <input aria-label="Find simulated instruments" value={search} maxLength={60}
            onChange={e => setSearch(e.target.value)} placeholder="NIFTY, FINNIFTY, QSYN…"/>
        </label>
        <div className="terminal-search-results" role="group" aria-label="Supported simulated instruments">
          {searchResults.length === 0 ? <p className="terminal-footnote">No matching supported simulation.</p> :
            searchResults.map(item => <div key={item.id} className="terminal-search-row">
              <button type="button" onClick={() => setSymbol(item.id)}>{item.id}</button>
              <button type="button" className="terminal-icon"
                aria-label={(saved.watchlist.includes(item.id) ? 'Unwatch ' : 'Watch ') + item.id}
                onClick={() => toggleWatch(item.id)}>
                {saved.watchlist.includes(item.id) ? <X size={14}/> : <Plus size={14}/>}
              </button>
            </div>)}
        </div>
        <a href="/qsyn/studio" className="terminal-studio-link">Open full Synthetic Studio <Layers size={15}/></a>
      </aside>
    </div>
  </div>;
}
function PrivateMarketPanel({ account, instrument, label }) {
  const ref = useRef(null);
  const [status, setStatus] = useState('Connecting private account authorization…');
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const feed = new PrivateAuthorizedChartFeed(account, instrument, setStatus);
    let widget;
    try {
      widget = createWidget(host, {
        feed, symbol:instrument, exchange:'UPSTOX_PRIVATE', interval:'1m',
        intervals:['1m'], theme:'dark', persist:false, panels:true,
      });
      widget.ready.catch(() => setStatus('Private chart widget unavailable. No demo data substituted.'));
    } catch {
      setStatus('Private chart widget unavailable. No demo data substituted.');
    }
    return () => {
      feed.destroy();
      try { widget?.destroy(); } catch {}
    };
  }, [account, instrument]);
  return <section className="terminal-chart-card">
    <div className="terminal-card-head"><h2>{label} · <small>{instrument}</small></h2><span className="terminal-chip">PRIVATE ONLY</span></div>
    <div className="terminal-chart-host" ref={ref} aria-label={'Private '+label+' licensed candlestick chart'} />
    <p className="terminal-footnote" role="status">{status}</p>
    <p className="terminal-footnote">Exchange last-trade timestamps. No historical candles until licensed backfill is verified.</p>
  </section>;
}
function PrivateMarketWorkspace() {
  const [access, setAccess] = useState('checking');
  const [account, setAccount] = useState('');
  const [ce, setCe] = useState('');
  const [pe, setPe] = useState('');
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/qsyn/api/v1/auth/state', {credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(r => r.ok ? r.json() : null)
      .then(r => {
        if (!controller.signal.aborted) setAccess(
          r?.authenticated === true && r?.profile === 'mock-only' ? 'private_test' : 'locked');
      }).catch(() => { if (!controller.signal.aborted) setAccess('locked'); });
    return () => controller.abort();
  }, []);
  const supported = validatePrivateChartScope(account.trim(), ce.trim()) &&
    validatePrivateChartScope(account.trim(), pe.trim()) && ce.trim() !== pe.trim();
  return <div className="terminal-page">
    <header className="terminal-title"><div><p className="terminal-eyebrow">PRIVATE · READ ONLY</p>
      <h1>Authorized CE/PE charts</h1><p>Separate from the simulated terminal. No public redistribution or order execution.</p>
    </div></header>
    <section className="terminal-surface terminal-live-controls">
      {access === 'checking' && <p role="status">Checking private identity access…</p>}
      {access === 'locked' && <p role="status">Unavailable. Requires an authenticated private development identity, verified Upstox entitlements, and an operator-provisioned WSS proxy. Simulation remains on the Trading tab.</p>}
      {access === 'private_test' && <>
        <p>Private test identity active. Enter only account and CE/PE keys approved in the private rights file. The grant issuer independently verifies access.</p>
        <div className="terminal-layout-tools">
          <label>Approved account alias<input aria-label="Approved account alias" value={account} maxLength={128} onChange={e => setAccount(e.target.value)}/></label>
          <label>CE instrument key<input aria-label="Private CE key" placeholder="NSE_FO|12345" value={ce} maxLength={32} onChange={e=>setCe(e.target.value)}/></label>
          <label>PE instrument key<input aria-label="Private PE key" placeholder="NSE_FO|12346" value={pe} maxLength={32} onChange={e=>setPe(e.target.value)}/></label>
          <button className="terminal-action" type="button" disabled={!supported}
            onClick={() => setSelected({account:account.trim(), ce:ce.trim(), pe:pe.trim()})}>Connect authorized charts</button>
          <button className="terminal-action terminal-secondary-action" type="button" onClick={() => setSelected(null)}>Disconnect</button>
        </div>
        <p className="terminal-footnote">No broker secret or Upstox OAuth token is entered in the browser. Chart grants expire after 30 seconds and require current server-side rights.</p>
      </>}
    </section>
    {access === 'private_test' && selected && <div className="terminal-private-chart-grid">
      <PrivateMarketPanel key={selected.account + selected.ce} account={selected.account} instrument={selected.ce} label="Call option (CE)"/>
      <PrivateMarketPanel key={selected.account + selected.pe} account={selected.account} instrument={selected.pe} label="Put option (PE)"/>
    </div>}
  </div>;
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
        <a className="terminal-quick" href={BASE + '?view=private-live'}>Private authorized CE/PE charts <LockKeyhole size={18}/></a>
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
        <span className="terminal-environment">{view === 'private-live' ? '● PRIVATE · GATED' : '● SIMULATED'}</span>
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
        <span>{view === 'private-live' ? <><b>Restricted market data.</b> No feed is assumed connected; licensed account login and WSS proxy required. No orders.</> : <><b>Simulation workspace.</b> No live market data, connected broker or executable orders.</>}</span></div>
      {view === 'dashboard' && <Dashboard capabilities={capabilities} openView={openView}/>}
      {view === 'trading' && <div className="terminal-page">
        <header className="terminal-title"><div><p className="terminal-eyebrow">MARKET WORKSPACE</p><h1>Trading charts</h1>
          <p>OpenAlgo Charts 2.6.0 with QSYN's existing simulated PHP data adapter.</p></div></header>
        <ChartWorkspace theme={theme}/></div>}
      {view === 'tools' && <Tools/>}
      {view === 'private-live' && <PrivateMarketWorkspace/>}
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

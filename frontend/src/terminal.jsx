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
  LockKeyhole, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search,
  Settings, ShieldAlert, Sun, Wallet, Wrench, X, Plus, Save, Columns2, Trash2, Route,
} from 'lucide-react';
import { createWidget, createChartGrid, mountIndicatorSettings } from 'openalgo-charts/widget';
import {bindIndicatorLegendSettings} from './indicator-legend-settings.js';
import { observeChartCancellations } from './chart-cancellation.js';
import { QsynMarketsFeed } from './qsyn-markets-feed.js';
import {AdminIndexHistoryFeed} from './admin-index-history-feed.js';
import {saveIndexIntent} from './private-index-intent.js';
import {MAX_AUTO_BACKFILL_BARS,INITIAL_BACKFILL_BARS} from './crypto-feed.js';
import {observeWickScienceBackfill} from './wick-science-auto-backfill.js';
import { cryptoDefault } from './crypto-catalog.js';
import { nativeCryptoWatchlists, noSyntheticQuotes } from './native-crypto-watchlists.js';
import 'openalgo-charts/indicators';
import {registerWickScience} from './wick-science-indicator.js';
registerWickScience();
import { QsynWorkspaceFeed } from './terminal-feed.js';
import { publicNativeWorkspaceStore, cryptoNativeWorkspaceStore } from './native-workspaces.js';
import { PrivateAuthorizedChartFeed, validatePrivateChartScope, isIndexInstrumentKey } from './private-live-chart.js';
import { checkPrivateWorkspace, savePrivateWorkspace } from './terminal-file-sync.js';
import {
  SYMBOLS, DEFAULT_PANES, instrumentFor, searchInstruments, loadBrowserWorkspace,
  storeBrowserWorkspace, saveNamedLayout, normalizeWorkspace,
} from './terminal-workspace.js';
import './terminal.css';
import { DashboardCockpit } from './dashboard.jsx';
import {DiagnosticsWorkspace,BrokersWorkspace,OperationsWorkspace} from './terminal-unified.jsx';
import {StrategyWorkspace} from './terminal-strategy.jsx';
import {MarketExplorer} from './market-explorer.jsx';
import {RouteManagementWorkspace} from './terminal-route-management.jsx';
import {terminalHref,terminalViewForLocation,defaultTerminalView,terminalRoutes} from './terminal-routes.js';

const VIEWS = new Set(terminalRoutes.map(route=>route.view));
// Navigation is product-oriented. Legacy routes remain valid but do not
// advertise demonstration trading or disconnected feature menus as products.
const sections = [
  { label:'Markets',view:'markets',icon:CandlestickChart },
  { label:'Workspaces & Templates',view:'workspaces',icon:Layers },
  { label:'Strategy Studio',view:'strategy',icon:FlaskConical },
  { label:'Data Providers & Connections',view:'brokers',icon:Wallet },
  { label:'Diagnostics',view:'diagnostics',icon:Activity },
  { label:'Rust Runtime',view:'operations',icon:Settings },
];
const mobileSections=sections.filter(s=>['markets','workspaces','strategy','brokers'].includes(s.view));
const unavailable = [
  { label: 'Orderbook', icon: ClipboardList },
  { label: 'Positions', icon: ChartColumnIncreasing },
  { label: 'Broker accounts', icon: Wallet },
];
function routeView() {
  return terminalViewForLocation(window.location.pathname,window.location.search) ?? defaultTerminalView;
}
function currentTheme() {
  try {
    const saved = localStorage.getItem('qsyn-terminal-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* browser storage is optional */ }
  // Match the bright full-width reference on first visit, preserving an
  // explicit light/dark preference and the original terminal defaults.
  return ['/qsyn/', '/qsyn', '/'].includes(window.location.pathname) ? 'light' : 'dark';
}
function ChartPanel({ pane, theme, savedState, revision, onMount, hideBranding = false, nativeWorkspaces = null, nativeLayouts = true }) {
  const host = useRef(null);
  const [message, setMessage] = useState('Loading simulated candles…');
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    const feed = new QsynWorkspaceFeed(text => { if (alive) setMessage(text); });
    let widget = null;
    let stopLegendSettings=()=>{};
    setProblem('');
    try {
      widget = createWidget(host.current, {
        feed, symbol: pane.symbol, exchange: 'QSYN', interval: '1m',
        intervals: ['1m'], theme, persist: false, panels: true,
        // Apache-2.0 library supports host-owned branding. Restrict removal
        // of its visible link to the chart-only homepage.
        ...(hideBranding ? { branding: false } : {}),
        ...(nativeWorkspaces ? { workspaces: nativeWorkspaces, ...(nativeLayouts ? {} : { layouts: false }) } : {}),
        navigation: { defaultVisibleBars: 95, mousePan: 'horizontal' },
      });
      stopLegendSettings=bindIndicatorLegendSettings(widget,mountIndicatorSettings);
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
      stopLegendSettings();
      try { widget?.destroy(); } catch {}
      feed.destroy();
    };
  }, [pane.id, pane.symbol, theme, revision, onMount, hideBranding, nativeWorkspaces, nativeLayouts]);
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
const HOME_PANE = Object.freeze({ id: 'primary', symbol: 'QSYN-NIFTY-STRADDLE' });
const ignoreHomepageWidget = () => {};

/**
 * The /qsyn/ landing page mirrors the supplied edge-to-edge OpenAlgo Charts
 * reference without removing any upstream chart controls. Its candles remain
 * explicitly simulated. Full workspace features remain at /qsyn/terminal.
 */
/**
 * The public landing page deliberately renders only the native OpenAlgo
 * chart. Navigation and all trading workspaces still exist at /qsyn/terminal.
 * Keep the simulated-data disclosure below the chart, outside its controls.
 */
/**
 * Single source of symbol selection: the native OpenAlgo symbol search and
 * watchlist. Reuse native grid action buttons beside its Watchlist control,
 * rather than duplicating exchange and layout dropdowns above the chart.
 */
function HomepageChart({ theme, embedded = false,
  initialExchange = cryptoDefault.exchange+':'+cryptoDefault.market,
  initialSymbol = cryptoDefault.symbol, onPrivateIndexRequest = null, adminIndexHistory = true }) {
  const host=useRef(null);
  const [message,setMessage]=useState('Connecting public exchange candles…');
  const [blockedIndex,setBlockedIndex]=useState(null);
  const nativeWorkspaces=useMemo(()=>cryptoNativeWorkspaceStore(),[]);
  const nativeWatchlists=useMemo(()=>nativeCryptoWatchlists(),[]);
  useEffect(()=>{
    if(!host.current)return;
    let active=true;
    // Upstream ChartGrid can reject an obsolete internal load when it cancels
    // a refresh or changes interval; a known AbortError is not an app fault.
    const updateState=s=>{if(active)setMessage(s);};
    const feed=adminIndexHistory
      ?new AdminIndexHistoryFeed(updateState,{
        onBlockedIndex:index=>{if(active)setBlockedIndex(index);}
      })
      :new QsynMarketsFeed(updateState,{
        onBlockedIndex:index=>{if(active)setBlockedIndex(index);}
      });
    const grid=createChartGrid(host.current,{
      feed,symbol:initialSymbol,
      exchange:initialExchange,
      interval:'1m',intervals:['1m','5m','15m','1h','1d'],
      theme,branding:false,panels:true,toolbar:true,bottombar:true,
      preset:'1x1',workspaces:(adminIndexHistory&&initialExchange.endsWith(':index'))?undefined:(nativeWorkspaces||undefined),
      lookbackBars:INITIAL_BACKFILL_BARS,
      // OpenAlgo's default 15s history deadline is too short for a bounded
      // 51-page maximum MFE backfill. Keep PHP/Rust timeouts per request.
      loading:{pageSize:300,maxBars:MAX_AUTO_BACKFILL_BARS,timeoutMs:120000},
      ...(!(adminIndexHistory&&initialExchange.endsWith(':index'))&&nativeWatchlists?{watchlist:{store:nativeWatchlists,quotes:noSyntheticQuotes}}:{}),
      links:{crosshair:true},navigation:{defaultVisibleBars:120,mousePan:'horizontal'},
    });
    // Keep OpenAlgo's buttons inside their OWN grid bar; reparenting them
    // into a chart intercepts the grid's outside-click menu handling.
    // Reserve one inline slot beside Watchlist and float the native bar onto it.
    let slot=null;
    const syncToolbar=()=>{
      if(!active)return;
      const root=host.current;
      const bar=root?.querySelector('.oac-grid__bar');
      const nativeWatchlist=grid.active()?.widget?.root?.querySelector('.oac-topbar__watchlist');
      if(!bar || !nativeWatchlist || !bar.querySelector('.oac-grid__layout'))return;
      const topbar=nativeWatchlist.parentElement;
      if(!slot) {
        slot=document.createElement('span');
        slot.className='qsyn-grid-toolbar-slot';
        slot.setAttribute('aria-hidden','true');
      }
      if(slot.parentElement!==topbar || slot.nextElementSibling!==nativeWatchlist)
        topbar.insertBefore(slot,nativeWatchlist);
      const gridRect=grid.root.getBoundingClientRect();
      const position=slot.getBoundingClientRect();
      bar.style.left=Math.max(0,Math.min(position.left-gridRect.left,gridRect.width-72))+'px';
      bar.style.top=(position.top-gridRect.top)+'px';
      bar.dataset.placed='true';
    };
    const observer=new MutationObserver(syncToolbar);
    observer.observe(host.current,{childList:true,subtree:true});
    // A canvas study-gear emits indicatorSettings but OpenAlgo 2.6.0 does
    // not itself turn that event into its native indicator-settings dialog.
    // Bind each grid cell, including non-active cells in multi-chart layouts.
    const legendStops=new Map();
    const syncLegendSettings=()=>{
      if(!active)return;
      const widgets=new Set(grid.cells().map(cell=>cell.widget).filter(Boolean));
      for(const [widget,stop] of legendStops){
        if(!widgets.has(widget)){stop();legendStops.delete(widget);}
      }
      for(const widget of widgets){
        if(!legendStops.has(widget))legendStops.set(widget,
          bindIndicatorLegendSettings(widget,mountIndicatorSettings));
      }
    };
    let seenWidget=null,stopWick=()=>{};
    const syncWick=()=>{
      if(!active)return;
      const widget=grid.active()?.widget;
      if(widget===seenWidget)return;
      stopWick();
      seenWidget=widget;
      stopWick=observeWickScienceBackfill(widget,feed);
    };
    const updateGrid=()=>{syncToolbar();syncLegendSettings();syncWick();};
    const offActive=grid.on('active',updateGrid);
    const offLayout=grid.on('layout',updateGrid);
    window.addEventListener('resize',syncToolbar);
    host.current.addEventListener('scroll',syncToolbar,true);
    void grid.ready.then(updateGrid).catch(()=>{
      if(active)setMessage('Public market feed unavailable · no demo fallback');
    });
    updateGrid();
    return ()=>{
      active=false;stopWick();
      for(const stop of legendStops.values())stop();legendStops.clear();
      observer.disconnect();offActive?.();offLayout?.();
      window.removeEventListener('resize',syncToolbar);
      host.current?.removeEventListener('scroll',syncToolbar,true);
      slot?.remove();
      grid.destroy();feed.destroy();
    };
  },[theme,nativeWorkspaces,nativeWatchlists,initialExchange,initialSymbol,adminIndexHistory]);
  const openPrivateIndex=()=>{
    if(!blockedIndex)return;
    if(typeof onPrivateIndexRequest==='function'){
      onPrivateIndexRequest(blockedIndex);
      return;
    }
    // The homepage is public. Only a previously authorized operator can
    // access licensed history in the private terminal. Persist alias only.
    saveIndexIntent(blockedIndex);
    window.location.assign('/qsyn/terminal/markets');
  };
  return <main className={embedded ? 'qsyn-homepage terminal-market-embedded' : 'qsyn-homepage'} aria-label="QSYN crypto and India index charts">
    <div className="qsyn-home-chart">
      <div className="qsyn-crypto-grid" ref={host}/>
      <span className="qsyn-screenreader-status" role="status" aria-live="polite">{message}</span>
      {blockedIndex && <div className="qsyn-india-entitlement-note" role="status">
        <strong>{blockedIndex.name} · private Upstox data required</strong>
        <button type="button" onClick={openPrivateIndex}>
          Open authorized {blockedIndex.symbol} chart
        </button>
        <span>No public NSE/BSE index candles are available here. A valid Upstox token alone does not grant display rights or start the private index worker.</span>
      </div>}
    </div>
  </main>;
}

function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}
function ChartWorkspace({ theme }) {
  const templateStore = useMemo(() => publicNativeWorkspaceStore(), []);
  const [saved, setSaved] = useState(() => loadBrowserWorkspace(browserStorage()));
  const [scope, setScope] = useState('browser');
  const [remote, setRemote] = useState({ status: 'not_checked' });
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [panes, setPanes] = useState(DEFAULT_PANES);
  const [active, setActive] = useState('primary');
  const [search, setSearch] = useState('');
  const [layoutName, setLayoutName] = useState('');
  const [snapshots, setSnapshots] = useState({});
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('Watchlist and layouts stay in this browser only.');
  const chartRefs = useRef(new Map());
  // Optional private development storage is probed ONLY after an explicit
  // operator click. Avoid 503 traffic on ordinary browser-only workspaces.
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
            : remote.status === 'not_checked' ? 'private storage not checked'
            : remote.status === 'offline' ? 'private storage unavailable'
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
        <button type="button" className="terminal-icon"
          disabled={remoteBusy} aria-label="Refresh private file status" onClick={refreshRemote}>
          <Activity size={15}/>
        </button>
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
          <ChartPanel pane={p} theme={theme} savedState={snapshots[p.id]} revision={revision} onMount={onMount}
            nativeLayouts={false}
            nativeWorkspaces={scope === 'browser' ? templateStore : null}/>
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
function PrivateMarketPanel({ account, instrument, label, authMode = 'private_test' }) {
  const ref = useRef(null);
  const [status, setStatus] = useState('Connecting private account authorization…');
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const feed = new PrivateAuthorizedChartFeed(account, instrument, setStatus, {authMode});
    let widget;
    let stopLegendSettings=()=>{};
    try {
      widget = createWidget(host, {
        feed, symbol:instrument, exchange:'UPSTOX_PRIVATE', interval:'1m',
        intervals:['1m'], theme:'dark', persist:false, panels:true,
      });
      stopLegendSettings=bindIndicatorLegendSettings(widget,mountIndicatorSettings);
      widget.ready.catch(() => setStatus('Private chart widget unavailable. No demo data substituted.'));
    } catch {
      setStatus('Private chart widget unavailable. No demo data substituted.');
    }
    return () => {
      stopLegendSettings();
      feed.destroy();
      try { widget?.destroy(); } catch {}
    };
  }, [account, instrument, authMode]);
  return <section className="terminal-chart-card">
    <div className="terminal-card-head"><h2>{label} · <small>{instrument}</small></h2><span className="terminal-chip">PRIVATE ONLY</span></div>
    <div className="terminal-chart-host" ref={ref} aria-label={'Private '+label+' licensed candlestick chart'} />
    <p className="terminal-footnote" role="status">{status}</p>
    <p className="terminal-footnote">{isIndexInstrumentKey(instrument)
      ? 'Index history requires an authorized private index reader and licensed backfill; live ticks require the separately approved Rust worker and WSS.'
      : 'Exchange last-trade timestamps. No historical candles until licensed backfill is verified.'}</p>
  </section>;
}
function PrivateMarketWorkspace({embedded=false,onlyIndex=false,selectedIndex=null}) {
  const [access, setAccess] = useState('checking');
  const [account, setAccount] = useState('');
  const [ce, setCe] = useState('');
  const [pe, setPe] = useState('');
  const [indexKey, setIndexKey] = useState('');
  const [selected, setSelected] = useState(null);
  useEffect(()=>{
    if(!onlyIndex)return;
    // Official Upstox documentation lists this NIFTY instrument key. It is
    // a candidate, not today's verified BOD mapping or market-data license.
    const candidate=selectedIndex?.exchange==='NSE_INDEX' &&
      selectedIndex?.symbol==='NIFTY' ? 'NSE_INDEX|Nifty 50' : '';
    setIndexKey(candidate);
    setSelected(null);
  },[onlyIndex,selectedIndex?.id]);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const operator = await fetch('/qsyn/api/v1/admin/upstox/private-chart-access', {
        credentials:'same-origin',cache:'no-store',signal:controller.signal,
      });
      if (operator.ok) {
        const data = await operator.json();
        if (data.schema === 'QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1' &&
            data.profile === 'operator-admin' && data.authenticated === true &&
            data.trading_enabled === false &&
            /^[A-Za-z0-9_.:-]{1,128}$/.test(data.account_id)) {
          if (!controller.signal.aborted) {
            setAccount(data.account_id);
            setAccess('operator_admin');
          }
        } else if (!controller.signal.aborted) setAccess('locked');
        return;
      }
      // Only absent/disabled operator routes may use the existing isolated
      // development identity. Never downgrade denied operator credentials.
      if (![404,503].includes(operator.status)) {
        if (!controller.signal.aborted) setAccess('locked');
        return;
      }
      const state = await fetch('/qsyn/api/v1/auth/state', {
        credentials:'same-origin',cache:'no-store',signal:controller.signal,
      });
      const data = state.ok ? await state.json() : null;
      if (!controller.signal.aborted) setAccess(
        data?.authenticated === true && data?.profile === 'mock-only' ? 'private_test' : 'locked');
    })().catch(() => { if (!controller.signal.aborted) setAccess('locked'); });
    return () => controller.abort();
  }, []);
  const supportedIndex = isIndexInstrumentKey(indexKey.trim()) &&
    validatePrivateChartScope(account.trim(), indexKey.trim());
  const supported = validatePrivateChartScope(account.trim(), ce.trim()) &&
    validatePrivateChartScope(account.trim(), pe.trim()) && ce.trim() !== pe.trim();
  return <div className={embedded ? 'qt-private-market-embedded' : 'terminal-page'}>
    {!embedded&&<header className="terminal-title"><div><p className="terminal-eyebrow">PRIVATE · READ ONLY</p>
      <h1>Authorized Upstox charts</h1><p>Private CE/PE and NSE/BSE indices. No public redistribution or order execution.</p>
    </div></header>}
    <section className="terminal-surface terminal-live-controls">
      {access === 'checking' && <p role="status">Checking private identity access…</p>}
      {access === 'locked' && <p role="status">Unavailable. Requires a private operator or development identity, independently approved Upstox index rights and an authenticated WSS proxy. No demo candles or order execution.</p>}
      {(access === 'private_test' || access === 'operator_admin') && <>
        <p>{access === 'operator_admin' ? 'Operator administrator session active. Your account is server-bound. Only independently approved NSE/BSE index keys can receive private 30-second viewer grants.' : 'Private test identity active. Enter only account, CE/PE or index keys approved in the private rights file. The grant issuer independently verifies access.'}</p>
        <div className="terminal-layout-tools">
          <label>Approved account alias<input aria-label="Approved account alias" value={account} readOnly={access === 'operator_admin'} maxLength={128} onChange={e => setAccount(e.target.value)}/></label>
          {access === 'private_test' && !onlyIndex && <>
          <label>CE instrument key<input aria-label="Private CE key" placeholder="NSE_FO|12345" value={ce} maxLength={32} onChange={e=>setCe(e.target.value)}/></label>
          <label>PE instrument key<input aria-label="Private PE key" placeholder="NSE_FO|12346" value={pe} maxLength={32} onChange={e=>setPe(e.target.value)}/></label>
          <button className="terminal-action" type="button" disabled={!supported}
            onClick={() => setSelected({account:account.trim(), ce:ce.trim(), pe:pe.trim()})}>Connect authorized charts</button></>}
          <label>{selectedIndex?.name ? selectedIndex.name+' · ' : ''}Approved NSE/BSE index instrument key<input aria-label="Private index instrument key" placeholder="NSE_INDEX|Nifty 50" value={indexKey} maxLength={128} onChange={e=>setIndexKey(e.target.value)}/></label>
          <button className="terminal-action" type="button" disabled={!supportedIndex}
            onClick={() => setSelected({account:account.trim(),index:indexKey.trim()})}>Connect authorized index</button>
          <button className="terminal-action terminal-secondary-action" type="button" onClick={() => setSelected(null)}>Disconnect</button>
        </div>
        {onlyIndex && selectedIndex && <p role="status" className="terminal-footnote">
          Selected: {selectedIndex.name} ({selectedIndex.exchange}).
          {' '}The instrument key is only a candidate until matched against the
          current Upstox instrument master and approved private rights.
          Connecting will not activate an unapproved worker or expose public candles.
        </p>}
        <p className="terminal-footnote">No broker secret or Upstox OAuth token is entered in the browser. Chart grants expire after 30 seconds and require current server-side rights.</p>
      </>}
    </section>
    {(access === 'private_test' || access === 'operator_admin') && selected && <div className="terminal-private-chart-grid">
{selected.index ?
        <PrivateMarketPanel key={selected.account + selected.index} account={selected.account} instrument={selected.index} label="Upstox index" authMode={access === 'operator_admin' ? 'operator_admin' : 'private_test'}/> : <>
        <PrivateMarketPanel key={selected.account + selected.ce} account={selected.account} instrument={selected.ce} label="Call option (CE)"/>
        <PrivateMarketPanel key={selected.account + selected.pe} account={selected.account} instrument={selected.pe} label="Put option (PE)"/>
      </>}
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
          <a className="terminal-quick" href={terminalHref('trading')}>Trading charts <CandlestickChart size={18}/></a>
          <a className="terminal-quick" href="/qsyn/studio">Synthetic Studio <Layers size={18}/></a>
          <a className="terminal-quick" href={terminalHref('tools')}>Tools & integrations <Wrench size={18}/></a>
        <a className="terminal-quick" href={terminalHref('private-live')}>Private authorized CE/PE charts <LockKeyhole size={18}/></a>
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
function Tools({openView}) {
  return (
    <div className="terminal-page">
      <header className="terminal-title"><div><p className="terminal-eyebrow">ANALYTICS</p>
        <h1>Tools</h1><p>Tools are enabled only when their QSYN backend contracts exist.</p>
      </div></header>
      <div className="terminal-tool-grid">
        <button type="button" className="terminal-tool" onClick={()=>openView('strategy')}><Layers /><h2>Strategy Studio</h2><p>Simulated CE/PE legs, combined premiums, option chain, expiry payoff and saved research setups.</p><span>Open workspace →</span></button>
        <button type="button" className="terminal-tool" onClick={()=>openView('markets')}><CandlestickChart /><h2>Public market charts</h2><p>Live crypto charts, licensed India index discovery, native indicators and drawings.</p><span>Open markets →</span></button>
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
  const [sessionWarning, setSessionWarning] = useState('');
  const [capabilities, setCapabilities] = useState(null);
  useEffect(() => {
    if (['/', '/qsyn', '/qsyn/'].includes(window.location.pathname)) return;
    let active = true;
    const check = async () => {
      if (!active || document.visibilityState === 'hidden') return;
      try {
        const result = await fetch('/qsyn/api/v1/admin/rust/state', {
          credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},
        });
        // Transport errors and 5xx are NOT authorization failures. A prior
        // implementation incorrectly redirected every transient network error.
        if (result.status === 401) {
          window.location.replace('/qsyn/terminal/login');
          return;
        }
        if (!result.ok) {
          if (active) setSessionWarning('ADMIN_STATE_HTTP_'+result.status);
          return;
        }
        const state=await result.json();
        if (!state || typeof state.authenticated!=='boolean') {
          if (active) setSessionWarning('ADMIN_STATE_INVALID_RESPONSE');
          return;
        }
        if (!state.authenticated) {
          window.location.replace('/qsyn/terminal/login');
          return;
        }
        if (active) setSessionWarning('');
      } catch {
        if (active) setSessionWarning('ADMIN_STATE_NETWORK_UNAVAILABLE');
      }
    };
    void check();
    const interval = window.setInterval(check, 60000);
    const visible=()=>{if (document.visibilityState==='visible') void check();};
    document.addEventListener('visibilitychange',visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange',visible); };
  }, []);
  useEffect(() => {
    const change = () => setView(routeView());
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-qsyn-theme', theme);
  }, [theme]);
  // Respect the two distinct page defaults. Do not silently save the
  // homepage's bright default as a user preference for the full terminal.
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('qsyn-terminal-theme', next); } catch {}
  }
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
    const target=terminalHref(next);
    if(!target) return;
    if (['/', '/qsyn', '/qsyn/'].includes(window.location.pathname)) {
      // Full navigation MUST go through PHP's admin gate, never pushState.
      window.location.assign(target);
      return;
    }
    if(window.location.pathname!==target || window.location.search)
      window.history.pushState(null, '', target);
    setView(next);
    setSidebar(false);
  }
  async function signOutTerminal() {
    try {
      const result = await fetch('/qsyn/api/v1/admin/rust/state', {
        credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},
      });
      const state = await result.json();
      if (result.ok && state.authenticated && typeof state.csrf === 'string') {
        await fetch('/qsyn/api/v1/admin/rust/logout', {
          method:'POST',credentials:'same-origin',cache:'no-store',
          headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
          body:'{}',
        });
      }
    } finally {
      window.location.replace('/qsyn/terminal/login');
    }
  }
  function Navigation({ mobile = false }) {
    return <nav aria-label={mobile ? 'Mobile terminal' : 'Terminal'}>
      <p className="terminal-nav-label">RESEARCH & DATA</p>
      {sections.map(s => <button key={s.view} type="button"
        aria-current={view === s.view ? 'page' : undefined}
        className={'terminal-nav-item' + (view === s.view ? ' active' : '')}
        onClick={() => openView(s.view)}><s.icon size={18}/><span>{s.label}</span></button>)}
      <p className="terminal-nav-label">SYSTEM</p>
      <button type="button" className="terminal-nav-item" onClick={()=>openView('routes')}>
        <Route size={18}/><span>Route management</span></button>
    </nav>;
  }
  if (['/', '/qsyn', '/qsyn/'].includes(window.location.pathname)) {
    return <HomepageChart theme={theme}/>;
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
        <span className="terminal-environment">● ADMIN TERMINAL · {['private-live','brokers','operations'].includes(view)?'RESTRICTED':view==='markets'||view==='diagnostics'?'MARKET DATA · READ ONLY':'RESEARCH ONLY'}</span>
        <button type="button" className="terminal-icon" aria-label="Toggle theme"
          onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button>
        <button type="button" className="terminal-icon" onClick={()=>openView('operations')} aria-label="Terminal operations" title="Protected Rust administration"><Settings size={17}/></button>
        <button type="button" className="terminal-icon" onClick={()=>void signOutTerminal()} aria-label="Sign out of QSYN terminal" title="Sign out"><LogOut size={17}/></button>
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
      {sessionWarning && <div className="terminal-alert" role="status">
        <ShieldAlert size={17}/>
        <span><b>Session check unavailable.</b> {sessionWarning}. Your terminal remains visible,
          but protected requests can fail until connectivity is restored. Open Diagnostics to copy a safe report.</span>
        <button type="button" className="terminal-action terminal-secondary-action"
          onClick={()=>openView('diagnostics')}>Diagnostics</button>
      </div>}
      <div className="terminal-alert" role="note"><ShieldAlert size={17}/>
        <span>{view==='private-live'||view==='brokers'||view==='operations'
          ? <><b>Restricted source management.</b> Authentication, display rights and worker activation are independent. Orders disabled.</>
          : view==='markets'||view==='diagnostics'
          ? <><b>Source-aware markets.</b> Public crypto is separate from licensed India feeds. Provider health and chart availability are verified independently. Orders disabled.</>
          : <><b>Research-only workspace.</b> Simulated data is never treated as exchange prices. Orders disabled.</>}</span></div>
      {view === 'dashboard' && <DashboardCockpit capabilities={capabilities} openView={openView} theme={theme} ChartPanel={ChartPanel}/>}
      {view === 'markets' && <MarketExplorer theme={theme} openView={openView}
        CryptoChart={HomepageChart} PrivateCharts={PrivateMarketWorkspace}/>} 
      {view === 'strategy' && <StrategyWorkspace theme={theme}/>}
      {view === 'workspaces' && <div className="terminal-page"><header className="terminal-title">
        <div><p className="terminal-eyebrow">SAVED LAYOUTS</p><h1>Chart workspaces</h1>
        <p>Browser-local simulated research layouts and optional separately authorized private files.</p></div></header>
        <ChartWorkspace theme={theme}/></div>}
      {view === 'brokers' && <BrokersWorkspace openView={openView}/>}
      {view === 'diagnostics' && <DiagnosticsWorkspace/>}
      {view === 'operations' && <OperationsWorkspace/>}
      {view === 'routes' && <RouteManagementWorkspace openView={openView}/>} 
      {view === 'trading' && <div className="terminal-page">
        <header className="terminal-title"><div><p className="terminal-eyebrow">COMPATIBILITY · SIMULATION ONLY</p><h1>Legacy Chart Lab</h1>
          <p>This legacy route remains available for existing saved simulated layouts. No order execution or live market source is connected.</p></div></header>
        <ChartWorkspace theme={theme}/></div>}
      {view === 'tools' && <Tools openView={openView}/>}
      {view === 'private-live' && <PrivateMarketWorkspace/>}
    </main>
    <nav className="terminal-bottom-nav" aria-label="Mobile quick navigation">
      {mobileSections.map(s=><button type="button" key={s.view}
        className={view === s.view ? 'active':''} aria-current={view === s.view ? 'page':undefined}
        onClick={()=>openView(s.view)}><s.icon size={18}/><span>{s.label}</span></button>)}
      <button type="button" onClick={()=>openView('diagnostics')}><Activity size={18}/><span>Health</span></button>
    </nav>
  </div>;
}
// Keep the narrowly scoped cancellation listener for the entire React lifetime.
// Removing it in a chart effect cleanup can race the browser's later
// unhandledrejection dispatch from OpenAlgo grid.destroy().
const root = document.getElementById('qsyn-root');
if (root) {
  observeChartCancellations(window);
  createRoot(root).render(<App />);
}

/**
 * Browser-only, per-instrument indicator autosave for the public QSYN chart.
 *
 * Do not persist WidgetState, full ChartState, OHLC, OAuth/session data,
 * orders, alerts or drawings here. Native named workspaces remain separate.
 */
export const INDICATOR_STORAGE_KEY = 'qsyn-home-indicators-v1';
const SCHEMA = 'QSYN-HOME-INDICATORS/1';
const MAX_BYTES = 90000;
const MAX_STUDIES = 32;
const MAX_PROFILES = 20;

function instrumentKey(widget) {
  const exchange = widget?.exchange?.();
  const symbol = widget?.symbol?.();
  if (typeof exchange !== 'string' || typeof symbol !== 'string' ||
      !exchange || !symbol || exchange.length > 100 || symbol.length > 120) return null;
  return JSON.stringify([exchange, symbol]);
}

function cleanStudies(value) {
  if (!Array.isArray(value) || value.length > MAX_STUDIES ||
      !value.every(item => item && typeof item === 'object' &&
        typeof item.indicatorId === 'string' && item.indicatorId.length > 0)) return null;
  try {
    // getState() produces JSON-safe indicator descriptors. Round-trip them to
    // remove prototypes and reject oversized custom inputs.
    const json = JSON.stringify(value);
    return json.length <= MAX_BYTES / 2 ? JSON.parse(json) : null;
  } catch { return null; }
}

function read(storage) {
  const blank = { schema: SCHEMA, profiles: {} };
  try {
    const raw = storage?.getItem(INDICATOR_STORAGE_KEY);
    if (!raw || raw.length > MAX_BYTES) return blank;
    const saved = JSON.parse(raw);
    if (saved?.schema !== SCHEMA || !saved.profiles ||
        typeof saved.profiles !== 'object' || Array.isArray(saved.profiles)) return blank;
    const profiles = {};
    for (const [key, profile] of Object.entries(saved.profiles).slice(-MAX_PROFILES)) {
      if (key.length > 250 || !Array.isArray(profile?.indicators)) continue;
      const indicators = cleanStudies(profile.indicators);
      if (indicators !== null) profiles[key] = { indicators };
    }
    return { schema: SCHEMA, profiles };
  } catch { return blank; }
}

function store(storage, document, key, studies) {
  if (!storage || !key || !studies) return false;
  const profiles = { ...document.profiles };
  // Reinsert the modified profile at the end, pruning least recently edited.
  delete profiles[key];
  profiles[key] = { indicators: studies };
  while (Object.keys(profiles).length > MAX_PROFILES) delete profiles[Object.keys(profiles)[0]];
  let json = JSON.stringify({ schema: SCHEMA, profiles });
  while (json.length > MAX_BYTES && Object.keys(profiles).length > 1) {
    delete profiles[Object.keys(profiles)[0]];
    json = JSON.stringify({ schema: SCHEMA, profiles });
  }
  if (json.length > MAX_BYTES) return false;
  try {
    storage.setItem(INDICATOR_STORAGE_KEY, json);
    document.profiles = profiles;
    return true;
  } catch { return false; }
}

/**
 * Follow live OpenAlgo grid cells, including cells added/replaced by layouts.
 * Restores only indicators, using the engine's validated partial state restore.
 * An explicit native workspace with existing studies wins at initial attach.
 */
export function bindAutoSavedIndicators(grid, storage) {
  if (!grid || !storage) return () => {};
  const document = read(storage);
  const bindings = new Map();
  let active = true;

  function attach(widget) {
    const chart = widget.chart;
    if (!chart || typeof chart.getState !== 'function' ||
        typeof chart.restoreState !== 'function' ||
        typeof chart.on !== 'function' || typeof widget.on !== 'function') return () => {};
    let key = instrumentKey(widget);
    let restoring = 0;
    const stops = [];

    function restore() {
      const profile = key && document.profiles[key];
      if (!profile) return false;
      let state;
      try { state = chart.getState(); } catch { return false; }
      if (cleanStudies(profile.indicators) === null) return false;
      restoring++;
      try {
        // Do not restore old viewport, pane scales, drawings or chart feeds.
        const report = chart.restoreState({ version: state.version, indicators: profile.indicators });
        return report?.applied === true;
      } catch { return false; }
      finally { restoring--; }
    }

    function save() {
      if (!active || restoring || widget.isDestroyed || !key) return;
      let indicators;
      try { indicators = cleanStudies(chart.getState().indicators); } catch { return; }
      if (indicators !== null) store(storage, document, key, indicators);
    }

    // A named native workspace may already have placed studies on this cell.
    // Do not overwrite that explicit selection with a previous autosave.
    try {
      if (chart.getState().indicators?.length === 0) restore();
    } catch { /* The chart remains usable when a saved profile is invalid. */ }

    stops.push(chart.on('objects:change', save));
    stops.push(chart.on('indicatorRemoved', save));
    stops.push(chart.on('state:restore:start', () => { restoring++; }));
    stops.push(chart.on('state:restore:end', () => {
      restoring = Math.max(0, restoring - 1);
      if (!restoring) save();
    }));
    stops.push(widget.on('symbol', () => {
      key = instrumentKey(widget);
      // Switching instruments keeps the current studies unless that market
      // has its own saved set. An explicit empty set clears them.
      restore();
    }));
    return () => { for (const stop of stops) stop?.(); };
  }

  function sync() {
    if (!active) return;
    const widgets = new Set(grid.cells().map(cell => cell.widget).filter(Boolean));
    for (const [widget, stop] of bindings) {
      if (!widgets.has(widget)) { stop(); bindings.delete(widget); }
    }
    for (const widget of widgets) if (!bindings.has(widget)) bindings.set(widget, attach(widget));
  }

  const offActive = grid.on('active', sync);
  const offLayout = grid.on('layout', sync);
  sync();
  void Promise.resolve(grid.ready).then(sync).catch(() => {});
  return () => {
    active = false;
    offActive?.();
    offLayout?.();
    for (const stop of bindings.values()) stop();
    bindings.clear();
  };
}

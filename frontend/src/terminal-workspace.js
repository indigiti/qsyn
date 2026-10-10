/**
 * Strict client-only simulated-instrument catalog and browser workspace model.
 * There is NO server-side shared watchlist, identity, broker credential or DB.
 */
export const SYMBOLS = Object.freeze([
  { id: 'QSYN-DEMO', label: 'QSYN sample candles', kind: 'sample', underlying: null },
  { id: 'QSYN-NIFTY-STRADDLE', label: 'NIFTY ATM straddle · synthetic demo', kind: 'synthetic', underlying: 'NIFTY' },
  { id: 'QSYN-BANKNIFTY-STRADDLE', label: 'BANKNIFTY ATM straddle · synthetic demo', kind: 'synthetic', underlying: 'BANKNIFTY' },
  { id: 'QSYN-FINNIFTY-STRADDLE', label: 'FINNIFTY ATM straddle · synthetic demo', kind: 'synthetic', underlying: 'FINNIFTY' },
]);
const IDS = new Set(SYMBOLS.map(s => s.id));
export const STORAGE_KEY = 'qsyn-terminal-browser-workspaces-v2';
export const STORAGE_SCHEMA = 'QSYN-TERMINAL-BROWSER-WORKSPACES/1';
const MAX_BYTES = 180000;
export const DEFAULT_WATCHLIST = ['QSYN-DEMO', 'QSYN-NIFTY-STRADDLE'];
export const DEFAULT_PANES = [{ id: 'primary', symbol: 'QSYN-DEMO' }];
const VALID_PANES = ['primary', 'secondary'];

export function validSymbol(value) {
  return typeof value === 'string' && IDS.has(value);
}
export function instrumentFor(symbol) {
  return SYMBOLS.find(item => item.id === symbol) || null;
}
export function searchInstruments(query) {
  const q = String(query ?? '').trim().toUpperCase().slice(0, 60);
  return SYMBOLS.filter(item => !q ||
    item.id.includes(q) || item.label.toUpperCase().includes(q));
}
export function validPanes(panes) {
  return Array.isArray(panes) && panes.length >= 1 && panes.length <= 2 &&
    panes.every((p, index) => p && typeof p === 'object' &&
      p.id === VALID_PANES[index] && validSymbol(p.symbol));
}
function cleanChartState(data, symbol) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.symbol !== symbol || data.exchange !== 'QSYN' || data.interval !== '1m') return null;
  try {
    const encoded = JSON.stringify(data);
    if (!encoded || encoded.length > 60000) return null;
    return JSON.parse(encoded);
  } catch { return null; }
}
export function safeLayout(input) {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' ||
      !/^[a-zA-Z0-9 _-]{1,36}$/.test(input.name) || !validPanes(input.panes)) return null;
  const chartStates = {};
  for (const pane of input.panes) {
    const state = cleanChartState(input.chartStates?.[pane.id], pane.symbol);
    if (state) chartStates[pane.id] = state;
  }
  return { name: input.name, panes: input.panes.map(p => ({ id: p.id, symbol: p.symbol })), chartStates };
}
export function defaultWorkspace() {
  return { schema: STORAGE_SCHEMA, watchlist: [...DEFAULT_WATCHLIST], layouts: [] };
}
export function normalizeWorkspace(value) {
  if (!value || value.schema !== STORAGE_SCHEMA) return defaultWorkspace();
  const watchlist = Array.isArray(value.watchlist)
    ? [...new Set(value.watchlist.filter(validSymbol))].slice(0, SYMBOLS.length)
    : [...DEFAULT_WATCHLIST];
  const layouts = [];
  const used = new Set();
  for (const item of Array.isArray(value.layouts) ? value.layouts.slice(0, 10) : []) {
    const safe = safeLayout(item);
    if (!safe || used.has(safe.name.toLowerCase())) continue;
    used.add(safe.name.toLowerCase());
    layouts.push(safe);
    if (layouts.length === 5) break;
  }
  return { schema: STORAGE_SCHEMA, watchlist, layouts };
}
export function loadBrowserWorkspace(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_BYTES) return defaultWorkspace();
    return normalizeWorkspace(JSON.parse(raw));
  } catch { return defaultWorkspace(); }
}
export function storeBrowserWorkspace(storage, value) {
  const normalized = normalizeWorkspace(value);
  const text = JSON.stringify(normalized);
  if (text.length > MAX_BYTES) throw new Error('Workspace exceeds browser storage safety limit.');
  try {
    storage.setItem(STORAGE_KEY, text);
  } catch {
    throw new Error('Browser storage is unavailable; the workspace was not saved.');
  }
  return normalized;
}
export function saveNamedLayout(workspace, layout) {
  const safe = safeLayout(layout);
  if (!safe) throw new Error('Invalid name or chart selection.');
  const state = normalizeWorkspace(workspace);
  const existing = state.layouts.findIndex(l => l.name.toLowerCase() === safe.name.toLowerCase());
  if (existing >= 0) state.layouts[existing] = safe;
  else {
    if (state.layouts.length >= 5) throw new Error('Five saved layouts maximum. Remove one first.');
    state.layouts.push(safe);
  }
  return state;
}

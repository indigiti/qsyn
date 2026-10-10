import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYMBOLS, STORAGE_KEY, STORAGE_SCHEMA, defaultWorkspace, instrumentFor,
  searchInstruments, validPanes, normalizeWorkspace, loadBrowserWorkspace,
  storeBrowserWorkspace, saveNamedLayout,
} from '../src/terminal-workspace.js';

test('catalog only accepts approved simulated symbols, search never accepts arbitrary broker instruments', () => {
  assert.equal(SYMBOLS.length, 4);
  assert.equal(instrumentFor('NSE:RELIANCE'), null);
  assert.equal(searchInstruments('nifty').length, 3);
  assert.deepEqual(searchInstruments('reliance'), []);
  assert.deepEqual(searchInstruments(''), SYMBOLS);
});
test('rejects malformed layout, mismatched chart state and duplicate panes', () => {
  assert.equal(validPanes([{ id: 'primary', symbol: 'QSYN-DEMO' }]), true);
  assert.equal(validPanes([{ id: 'secondary', symbol: 'QSYN-DEMO' }]), false);
  assert.equal(validPanes([{ id: 'primary', symbol: 'NSE:BAD' }]), false);
  const raw = {
    schema: STORAGE_SCHEMA, watchlist: ['NSE:BAD', 'QSYN-DEMO', 'QSYN-DEMO', 'QSYN-FINNIFTY-STRADDLE'],
    layouts: [
      { name: 'Good', panes: [{ id: 'primary', symbol: 'QSYN-DEMO' }],
        chartStates: { primary: { symbol: 'NSE:RELIANCE', exchange: 'NSE', interval: '1m' } } },
      { name: 'Good', panes: [{ id: 'primary', symbol: 'QSYN-DEMO' }] },
      { name: '../evil', panes: [{ id: 'primary', symbol: 'QSYN-DEMO' }] },
    ],
  };
  const clean = normalizeWorkspace(raw);
  assert.deepEqual(clean.watchlist, ['QSYN-DEMO', 'QSYN-FINNIFTY-STRADDLE']);
  assert.equal(clean.layouts.length, 1);
  assert.deepEqual(clean.layouts[0].chartStates, {});
});
test('browser-local watchlist and layouts are persisted, updated and reloaded safely', () => {
  const data = new Map();
  const store = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  const snapshot = { symbol: 'QSYN-DEMO', exchange: 'QSYN', interval: '1m', chart: { visible: 50 } };
  const layout = {
    name: 'Saved grid', panes: [
      { id: 'primary', symbol: 'QSYN-DEMO' },
      { id: 'secondary', symbol: 'QSYN-NIFTY-STRADDLE' },
    ],
    chartStates: { primary: snapshot },
  };
  let state = saveNamedLayout(defaultWorkspace(), layout);
  state.watchlist.push('QSYN-FINNIFTY-STRADDLE');
  storeBrowserWorkspace(store, state);
  const restored = loadBrowserWorkspace(store);
  assert.equal(restored.layouts.length, 1);
  assert.equal(restored.layouts[0].panes.length, 2);
  assert.deepEqual(restored.layouts[0].chartStates.primary, snapshot);
  assert.equal(restored.watchlist.length, 3);
  const replaced = saveNamedLayout(restored, { ...layout, panes: [{ id: 'primary', symbol: 'QSYN-DEMO' }] });
  assert.equal(replaced.layouts.length, 1);
  assert.equal(replaced.layouts[0].panes.length, 1);
  assert.ok(data.get(STORAGE_KEY).includes('Saved grid'));
});
test('broken, oversized or blocked local storage falls back or errors without enabling anything', () => {
  const bad = { getItem: () => 'not-json', setItem: () => { throw Error('full'); } };
  assert.deepEqual(loadBrowserWorkspace(bad), defaultWorkspace());
  assert.throws(() => storeBrowserWorkspace(bad, defaultWorkspace()), /storage is unavailable/);
  assert.deepEqual(loadBrowserWorkspace({ getItem: () => 'x'.repeat(190000) }), defaultWorkspace());
  assert.throws(() => saveNamedLayout(defaultWorkspace(), { name: '*', panes: [] }), /Invalid/);
  const state = defaultWorkspace();
  for (let i = 0; i < 5; i++) state.layouts.push({
    name: 'Layout'+i, panes: [{ id: 'primary', symbol: 'QSYN-DEMO' }], chartStates: {},
  });
  assert.throws(() => saveNamedLayout(state, {
    name: 'Sixth', panes: [{ id: 'primary', symbol: 'QSYN-DEMO' }],
  }), /maximum/);
});

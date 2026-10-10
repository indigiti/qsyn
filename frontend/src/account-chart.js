import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';

// Browser never chooses an authorization context: /accounts/bars reads the
// currently selected, session-owned mock account on the PHP server.
let currentAccount = null;
let mounting = null;

async function fetchMockHistory(expectedId) {
  const response = await fetch('/qsyn/api/v1/accounts/bars', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Authorized simulated chart history unavailable');
  const result = await response.json();
  if (result.mode !== 'simulated' ||
      result.source !== 'account-scoped-mock-fixture' ||
      result.account_id !== expectedId ||
      result.symbol !== 'QSYN-MOCK' || result.exchange !== 'QSYN' ||
      result.trading_enabled !== false || !Array.isArray(result.bars)) {
    throw new Error('Unexpected simulated chart provenance');
  }
  return result.bars;
}

async function mount(root, expectedId, prefs) {
  if (!prefs || !['dark', 'light'].includes(prefs.theme) ||
      ![60, 100, 120].includes(prefs.visible_bars) ||
      !['split', 'focus'].includes(prefs.layout)) {
    throw new Error('Invalid server-saved workspace options');
  }
  if (!root || !/^[a-f0-9-]{36}$/.test(expectedId)) throw new Error('Invalid selected mock account');
  if (currentAccount === expectedId && mounting) return mounting;
  if (currentAccount !== null) {
    // Account switching intentionally reloads the application rather than
    // risking subscriptions or stale browser chart state from another user.
    throw new Error('Account switch requires chart reset');
  }
  currentAccount = expectedId;
  const feed = {
    getBars: ({ symbol, interval }) => {
      if (symbol !== 'QSYN-MOCK' || interval !== '1m') {
        return Promise.resolve([]);
      }
      return fetchMockHistory(expectedId);
    },
    // Static fake candles only; real broker ticks and trading are disabled.
    subscribeBars: () => () => {},
  };
  root.replaceChildren();
  const widget = createWidget(root, {
    feed,
    symbol: 'QSYN-MOCK',
    exchange: 'QSYN',
    interval: '1m',
    theme: prefs.theme,
    // No browser localStorage persistence: the PHP session-owned workspace
    // is the only authority for selected-account chart preferences.
    navigation: { defaultVisibleBars: prefs.visible_bars, mousePan: 'horizontal' },
  });
  mounting = widget.ready.then(() => {
    return widget;
  });
  return mounting;
}
window.QsynAccountChart = { mount };

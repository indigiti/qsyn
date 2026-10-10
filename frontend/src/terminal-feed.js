/**
 * Only deterministic QSYN simulated instruments are addressable here.
 * This is not an exchange search, broker feed, entitlement, or live WSS adapter.
 */
import { QsynDemoFeed } from './rust-demo-feed.js';
import { instrumentFor } from './terminal-workspace.js';

const API = '/qsyn/api/v1/studio';
function validBars(rows) {
  return Array.isArray(rows) && rows.length === 120 && rows.every(bar =>
    bar && Number.isInteger(bar.time) && bar.time > 0 &&
    ['open', 'high', 'low', 'close'].every(k => Number.isFinite(bar[k]) && bar[k] >= 0) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}
export class QsynWorkspaceFeed {
  constructor(onState = () => {}) {
    this.closed = false;
    this.controllers = new Set();
    this.demo = new QsynDemoFeed(onState);
  }

  async getBars(request) {
    const symbol = request?.symbol;
    const definition = instrumentFor(symbol);
    if (!definition || request.exchange !== 'QSYN' || request.interval !== '1m') {
      // The widget has a symbol input; unsupported symbols may NEVER probe broker APIs.
      return [];
    }
    if (this.closed) return [];
    if (definition.kind === 'sample') {
      const bars = await this.demo.getBars(request);
      if (!validBars(bars)) throw new Error('Invalid simulated sample candles.');
      return bars;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const fetchDemo = async path => {
      const response = await fetch(path, {
        method: 'GET', cache: 'no-store', credentials: 'same-origin',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) throw new Error('Simulated QSYN options data unavailable.');
      return response.json();
    };
    try {
      const market = await fetchDemo(API + '/market?underlying=' + encodeURIComponent(definition.underlying));
      if (market.mode !== 'simulated' || market.trading_enabled !== false ||
          market.broker_connected !== false || market.underlying !== definition.underlying ||
          !Number.isInteger(market.atm) || !Number.isInteger(market.strike_step) ||
          market.strike_step <= 0 || market.atm <= 0) {
        throw new Error('Unexpected market source or simulated ATM.');
      }
      const legs = [
        { type: 'CE', side: 'BUY', strike: market.atm, qty: 1 },
        { type: 'PE', side: 'BUY', strike: market.atm, qty: 1 },
      ];
      const params = new URLSearchParams({
        underlying: definition.underlying, expiry: 'W1', interval: '1m',
        legs: JSON.stringify(legs),
      });
      const data = await fetchDemo(API + '/bars?' + params.toString());
      if (this.closed || controller.signal.aborted) return [];
      if (data.mode !== 'simulated' || data.source !== 'deterministic-options-laboratory' ||
          data.trading_enabled !== false || data.broker_connected !== false ||
          data.underlying !== definition.underlying || data.exchange !== 'QSYN' ||
          data.interval !== '1m' || data.legs?.length !== 2 || !validBars(data.bars)) {
        throw new Error('Unexpected synthetic source or invalid simulated OHLC.');
      }
      return data.bars;
    } finally {
      this.controllers.delete(controller);
    }
  }

  // Intentionally no subscribeBars: live broker/quote subscription is not approved.
  destroy() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.demo.stopSubscription();
  }
}

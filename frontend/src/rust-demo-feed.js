import { CandleBuilder } from 'openalgo-charts';

/**
 * Phase-0 opt-in Rust demo feed. All network requests are to a FIXED same-origin
 * PHP sample endpoint, which connects to Rust on private localhost.
 * This is a bounded polling bridge for testing only—not the production
 * high-throughput WebSocket topology or licensed broker market data.
 */
export class QsynDemoFeed {
  constructor(onState = () => {}) {
    this.onState = onState;
    this.connected = false;
    this.enabled = false;
    this.active = null;
    this.lastHistory = null;
    this.timer = null;
    this.pending = null;
    this.closed = false;
  }

  async getBars({ symbol, interval }) {
    if (symbol !== 'QSYN-DEMO') return [];
    const response = await fetch('/qsyn/api/v1/demo/bars', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('QSYN demo bars unavailable');
    const payload = await response.json();
    if (payload.mode !== 'simulated' || !Array.isArray(payload.bars)) {
      throw new Error('Unexpected data provenance');
    }
    this.lastHistory = interval === '1m' ? payload.bars.at(-1) : null;
    return payload.bars;
  }

  /** OpenAlgo Charts' official DataFeed live-bar contract. */
  subscribeBars(req, onBar, opts = {}) {
    this.stopSubscription();
    if (req.symbol !== 'QSYN-DEMO' || req.exchange !== 'QSYN' || req.interval !== '1m') {
      this.onState('Rust demo live chart currently supports QSYN-DEMO at 1m only.');
      return () => {};
    }
    const builder = new CandleBuilder({
      intervalSec: 60,
      volumeMode: 'ltq-sum',
      lateTickPolicy: 'dropOlderThanPrevBar',
    });
    const seed = opts.seedFrom || this.lastHistory;
    if (seed) builder.seed(seed);

    const subscription = { req, onBar, builder, opts, hadGap: false };
    this.active = subscription;
    if (this.enabled) this.schedule(0);
    return () => {
      if (this.active === subscription) this.stopSubscription();
    };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.onState(this.enabled ? 'Connecting to simulated Rust stream…' : 'Rust demo chart disconnected.');
    this.connected = false;
    this.clearPending();
    if (this.enabled && this.active) this.schedule(0);
  }

  schedule(ms) {
    if (!this.enabled || !this.active) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(this.active), ms);
  }

  clearPending() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending?.abort();
    this.pending = null;
  }

  stopSubscription() {
    this.clearPending();
    this.active = null;
    this.connected = false;
  }

  async poll(subscription) {
    if (!this.enabled || this.active !== subscription) return;
    const controller = new AbortController();
    this.pending = controller;
    const deadline = setTimeout(() => controller.abort(), 4500);
    let delay = 2500;
    try {
      const response = await fetch('/qsyn/api/v1/diagnostics/rust-stream', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Rust sample endpoint unavailable');
      const data = await response.json();
      if (this.active !== subscription || !this.enabled) return;
      if (data.status === 'demo_disabled') {
        this.enabled = false;
        this.connected = false;
        this.onState('Rust demo WebSocket is disabled. Enable it in QSYN administration.');
        return;
      }
      if (data.status !== 'streaming' || data.received !== 2 ||
          !Array.isArray(data.quotes) || data.quotes.length !== 2) {
        throw new Error('Rust stream unavailable (' + String(data.status || 'unknown') + ')');
      }
      let accepted = 0;
      for (const quote of data.quotes) {
        if (quote.source !== 'simulated' || quote.symbol !== 'QSYN-DEMO' ||
            !Number.isInteger(quote.timestamp) || !Number.isFinite(quote.price) ||
            quote.price <= 0) {
          throw new Error('Invalid simulated Rust quote');
        }
        const update = subscription.builder.onTick({
          time: quote.timestamp,
          price: quote.price,
          // No actual traded quantity exists for simulated price-only quotes.
          ltq: 0,
        });
        if (update) {
          subscription.onBar(update.bar, { provisional: update.provisional === true });
          accepted++;
        }
      }
      if (subscription.hadGap) {
        // The demo snapshots are not authoritative history. Indicate gaps
        // visibly; do not call onResync against unrelated PHP OHLC history.
        this.onState('Rust simulated stream restored; quotes may have gaps.');
      } else {
        this.onState('Connected to Rust simulation • ' + accepted + ' candle updates');
      }
      subscription.hadGap = false;
      this.connected = true;
    } catch (error) {
      if (controller.signal.aborted && this.active !== subscription) return;
      if (!this.enabled || this.active !== subscription) return;
      subscription.hadGap = true;
      this.connected = false;
      this.onState('Rust stream unavailable; historical PHP candles remain visible.');
      delay = 5000;
    } finally {
      clearTimeout(deadline);
      if (this.pending === controller) this.pending = null;
      if (this.enabled && this.active === subscription) this.schedule(delay);
    }
  }
}

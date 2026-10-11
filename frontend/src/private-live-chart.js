/**
 * Operator-private live chart bridge. Intentionally separate from the
 * simulated QSYN default feed: NEVER infer broker rights from cookies alone.
 *
 * Uses PHP same-origin CSRF-authorized, account+instrument-specific grants
 * and the Rust gateway's ticket-in-first-frame protocol. No bearer OAuth
 * token is delivered to JavaScript, URL, localStorage, or console.
 */
import { CandleBuilder } from 'openalgo-charts';

const TICKET_ENDPOINT = '/qsyn/api/v1/terminal/private-chart-grant';
const AUTH_ENDPOINT = '/qsyn/api/v1/auth/state';
const TICK_SCHEMA = 'QSYN-PRIVATE-CHART-TICK/1';
const INSTRUMENT = /^NSE_FO\|[0-9]{1,24}$/;
const INDEX_INSTRUMENT = /^(?:NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
export function isIndexInstrumentKey(value) {
  return typeof value === 'string' && value.length <= 128 &&
    INDEX_INSTRUMENT.test(value);
}
const ACCOUNT = /^[A-Za-z0-9_.:-]{1,128}$/;

export function validatePrivateChartScope(account, instrument) {
  return ACCOUNT.test(account) && (INSTRUMENT.test(instrument) || isIndexInstrumentKey(instrument));
}

export async function fetchPrivateChartGrant(fetcher, account, instrument, signal) {
  if (!validatePrivateChartScope(account, instrument))
    throw new Error('Select an operator-approved option account and NSE_FO instrument key.');
  const state = await fetcher(AUTH_ENDPOINT, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (!state.ok) throw new Error('Private test identity is not configured.');
  const identity = await state.json();
  if (identity.authenticated !== true || identity.profile !== 'mock-only'
      || !/^[a-f0-9]{64}$/.test(identity.csrf))
    throw new Error('Private test login required.');
  const response = await fetcher(TICKET_ENDPOINT, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: {'Content-Type':'application/json', 'X-CSRF-Token':identity.csrf},
    body: JSON.stringify({account_id: account, instrument}),
  });
  if (!response.ok) throw new Error('Current private display entitlement denied.');
  const result = await response.json();
  if (result.schema !== 'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1'
      || result.account_id !== account || result.instrument !== instrument
      || result.transport !== 'operator_private_wss_only'
      || result.trading_enabled !== false
      || result.public_redistribution_allowed !== false
      || !Number.isSafeInteger(result.expires_ms)
      || result.expires_ms <= Date.now() || result.expires_ms > Date.now() + 30000
      || typeof result.ticket !== 'string' || result.ticket.length > 2048)
    throw new Error('Invalid private chart authorization response.');
  return result;
}

export class PrivateAuthorizedChartFeed {
  constructor(account, instrument, onState = () => {}, deps = {}) {
    if (!validatePrivateChartScope(account, instrument))
      throw new Error('Invalid chart account or instrument');
    this.account = account;
    this.instrument = instrument;
    this.onState = onState;
    this.fetcher = deps.fetcher || fetch;
    this.socketFactory = deps.socketFactory || (url => new WebSocket(url));
    this.location = deps.location || location;
    this.schedule = deps.schedule || ((callback, ms) => setTimeout(callback, ms));
    this.cancel = deps.cancel || (handle => clearTimeout(handle));
    this.session = null;
    this.ended = false;
    this.sockets = new Set();
  }
  async getBars(request) {
    if (this.ended || request.symbol !== this.instrument ||
        request.exchange !== 'UPSTOX_PRIVATE' || request.interval !== '1m') return [];
    // The existing private history reader serves NSE_FO archives, not index
    // candles. Never request that endpoint or fill missing index history with
    // synthetic prices. The independently authorized WSS remains available.
    if (isIndexInstrumentKey(this.instrument)) {
      this.onState('Index history not provisioned; authorized live subscription only.');
      return [];
    }
    // History uses a SECOND short-lived, instrument-scoped PHP grant: neither
    // an Upstox token nor a signed grant is kept in browser storage or URL.
    let grant;
    try {
      grant = await fetchPrivateChartGrant(this.fetcher, this.account, this.instrument);
      if (this.ended) return [];
      const response = await this.fetcher('/qsyn/private-chart/history', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept:'application/json', Authorization:'Bearer ' + grant.ticket },
      });
      if (!response.ok) throw new Error('Private history not provisioned');
      const data = await response.json();
      if (data.schema !== 'QSYN-UPSTOX-PRIVATE-HISTORY/1' ||
          data.source !== 'licensed_private_history' ||
          data.account !== this.account || data.instrument !== this.instrument ||
          data.exchange !== 'UPSTOX_PRIVATE' || data.interval !== '1m' ||
          data.trading_enabled !== false ||
          data.public_redistribution_allowed !== false ||
          !Array.isArray(data.bars) || data.bars.length > 1200) {
        throw new Error('Private historical source or account invalid.');
      }
      let previous = 0;
      for (const row of data.bars) {
        if (!Number.isSafeInteger(row.time) || row.time <= previous ||
            row.time > Date.now() / 1000 ||
            !['open','high','low','close'].every(k => Number.isFinite(row[k]) && row[k] >= 0) ||
            row.close <= 0 || row.low > Math.min(row.open, row.close) ||
            row.high < Math.max(row.open, row.close)) {
          throw new Error('Private historical candle validation failed.');
        }
        previous = row.time;
      }
      this.onState(data.bars.length
        ? 'Licensed historical option-leg candles loaded (coverage not certified).'
        : 'No licensed history files imported for this instrument.');
      return this.ended ? [] : data.bars;
    } catch {
      if (!this.ended) this.onState('Private historical data unavailable; no demo prices used.');
      return [];
    }
  }
  subscribeBars(request, onBar) {
    if (this.ended || request.symbol !== this.instrument ||
        request.exchange !== 'UPSTOX_PRIVATE' || request.interval !== '1m')
      return () => {};
    this.stopSubscription();
    const controller = new AbortController();
    const builder = new CandleBuilder({intervalSec:60, volumeMode:'ltq-sum',
      lateTickPolicy:'dropOlderThanPrevBar'});
    const session = {
      controller, socket:null, closed:false, lastTimestamp:0,
      reconnectTimer:null, refreshTimer:null, retries:0,
    };
    this.session = session;
    const active = () => !session.closed && !this.ended &&
      this.session === session && !controller.signal.aborted;
    const clearTimers = () => {
      for (const key of ['reconnectTimer','refreshTimer']) {
        if (session[key] !== null) this.cancel(session[key]);
        session[key] = null;
      }
    };
    const discardSocket = () => {
      const old = session.socket;
      session.socket = null;
      if (!old) return;
      // A deliberately rotated socket must never schedule a second retry.
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      this.sockets.delete(old);
      try { old.close(1000); } catch {}
    };
    const backoff = () => Math.min(16000, 1000 * 2 ** Math.min(session.retries, 4));
    const retry = (message, renew = false) => {
      if (!active()) return;
      clearTimers();
      discardSocket();
      if (!renew && ++session.retries > 5) {
        this.onState('Private chart stopped after repeated connection failures; no simulated fallback.');
        this.stopSubscription();
        return;
      }
      this.onState(message);
      session.reconnectTimer = this.schedule(() => {
        session.reconnectTimer = null;
        if (active()) void start();
      }, renew ? 0 : backoff());
    };
    const start = async () => {
      if (!active()) return;
      try {
        // A new short-lived grant is mandatory for EVERY reconnection. It is
        // never retained in localStorage, URL parameters or diagnostic logs.
        const grant = await fetchPrivateChartGrant(
          this.fetcher, this.account, this.instrument, controller.signal);
        if (!active()) return;
        const scheme = this.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = scheme+'//'+this.location.host+'/qsyn/private-chart/ws';
        const socket = this.socketFactory(url);
        session.socket = socket;
        this.sockets.add(socket);
        socket.onopen = () => {
          if (active() && session.socket === socket &&
              grant.expires_ms > Date.now() + 1000) {
            socket.send(JSON.stringify({action:'authenticate', token:grant.ticket}));
          } else if (active() && session.socket === socket) {
            retry('Private chart ticket expired before connection; renewing.');
          }
        };
        socket.onmessage = event => {
          if (!active() || session.socket !== socket) return;
          let item;
          try { item = JSON.parse(event.data); } catch { return; }
          if (item.type === 'authentication_success') {
            if (item.source !== 'licensed_private_chart' ||
                item.expires_ms !== grant.expires_ms ||
                !Number.isSafeInteger(item.expires_ms) ||
                item.expires_ms <= Date.now() + 5000) {
              this.stopSubscription();
              return;
            }
            session.retries = 0;
            // Rust revalidates the ticket every second and disconnects at
            // expiry. Rotate with a *new* PHP grant well before that deadline.
            const refreshMs = Math.min(20000, item.expires_ms - Date.now() - 5000);
            clearTimers();
            session.refreshTimer = this.schedule(() => {
              session.refreshTimer = null;
              retry('Renewing private chart authorization…', true);
            }, Math.max(1000, refreshMs));
            this.onState('Private authorized chart connected · session renews automatically.');
            return;
          }
          if (item.schema !== TICK_SCHEMA || item.source !== 'private_verified_ltp'
              || item.account !== this.account || item.instrument !== this.instrument
              || !Number.isSafeInteger(item.time_ms) || !Number.isFinite(item.price)
              || item.price <= 0 || item.time_ms > Date.now() + 2000 ||
              Date.now() - item.time_ms > 5000) {
            this.stopSubscription();
            return;
          }
          // Provider snapshots and reconnects can replay the last exchange
          // timestamp. Ignore duplicates without clearing chart state.
          if (item.time_ms <= session.lastTimestamp) return;
          session.lastTimestamp = item.time_ms;
          const update = builder.onTick({time:Math.floor(item.time_ms/1000),
            price:item.price, ltq:0});
          if (update) onBar(update.bar, {provisional:update.provisional===true});
        };
        socket.onclose = () => retry(
          'Private chart connection closed; requesting fresh authorization.');
        socket.onerror = () => {
          if (active()) this.onState('Private WSS gateway error; retrying securely.');
          // onclose handles reconnection; never create overlapping sockets.
        };
      } catch (error) {
        if (!active()) return;
        // A denied/revoked chart grant may not be retried indefinitely.
        if ([401, 403].includes(error?.status)) {
          this.onState('Private chart authorization revoked or denied.');
          this.stopSubscription();
        } else {
          retry('Private chart temporarily unavailable; retrying authorization.');
        }
      }
    };
    void start();
    return () => { if (this.session === session) this.stopSubscription(); };
  }
  stopSubscription() {
    const session = this.session;
    if (!session) return;
    session.closed = true;
    session.controller.abort();
    for (const key of ['reconnectTimer','refreshTimer']) {
      if (session[key] !== null) this.cancel(session[key]);
      session[key] = null;
    }
    if (session.socket) {
      this.sockets.delete(session.socket);
      try { session.socket.close(1000); } catch {}
    }
    this.session = null;
  }
  destroy() {
    this.ended = true;
    this.stopSubscription();
    for (const socket of this.sockets) {
      try { socket.close(1000); } catch {}
    }
    this.sockets.clear();
  }
}

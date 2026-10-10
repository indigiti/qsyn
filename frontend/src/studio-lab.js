// QSYN integrated simulation lab: browser-only paper positions, replay,
// scenario risks, and foreground alerts. This module never sends POST requests,
// cannot route any order to an execution service, and stores no credentials.
const $ = id => document.getElementById(id);
const PKEY = 'qsyn-paper-ledger-v1';
const AKEY = 'qsyn-demo-alerts-v1';
const MAX_POSITIONS = 5;
const MAX_PREMIUM = 20000;
const format = n => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = n => (n >= 0 ? '+' : '') + format(n);

function readRecords(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(rows) ? rows.slice(-40) : [];
  } catch { return []; }
}
function store(key, rows) {
  localStorage.setItem(key, JSON.stringify(rows.slice(-40)));
}
function node(tag, text, className = '') {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
}
function signature(state) {
  return JSON.stringify([state.underlying, state.expiry,
    state.legs.map(l => [l.type, l.side, l.strike, l.qty])]);
}
function marks(data) {
  return data.legs.map(l => {
    const last = l.bars.at(-1);
    if (!last || !Number.isFinite(last.close) || last.close <= 0) {
      throw new Error('Missing simulated paper price');
    }
    return { type: l.type, side: l.side, strike: l.strike,
      qty: l.qty, fill: last.close };
  });
}
function pnl(fills, quote) {
  if (fills.length !== quote.length) throw new Error('Mismatched paper contract list');
  return fills.reduce((sum, fill, i) => sum +
    (fill.side === 'BUY' ? 1 : -1) * fill.qty * (quote[i].fill - fill.fill), 0);
}
function risk(data) {
  const a = data.analytics;
  if (!a || a.mode !== 'simulated'
      || a.trading_enabled !== false
      || a.model !== 'fixed-volatility-educational-scenario'
      || !a.scenario_risk || !a.greeks) {
    throw new Error('Risk analysis missing or not explicitly simulated');
  }
  const r = a.scenario_risk, g = a.greeks;
  $('risk-min').textContent = signed(r.min_pnl_points);
  $('risk-max').textContent = signed(r.max_pnl_points);
  $('risk-breakeven').textContent = r.breakevens_within_sample.length
    ? r.breakevens_within_sample.map(format).join(' / ') : 'None inside sampled range';
  for (const field of ['delta', 'gamma', 'vega_per_pct', 'theta_per_day']) {
    $('greek-' + field).textContent = signed(g[field]);
  }
  $('risk-warning').textContent = 'Model assumptions: fixed ' +
    (a.assumptions.volatility * 100).toFixed(0) + '% volatility, ' +
    a.assumptions.time_to_expiry_days + ' demo days to expiry, 0% rate. ' +
    'Payoff extrema apply only to the sampled settlement range. Not market Greeks or real risk limits.';
  $('risk-drawdown').textContent = format(a.history.max_drawdown_premium_points);
}

export function bindStudioLab({ data, config, onStatus, renderReplay }) {
  risk(data);
  const key = signature(config);
  let selected = 119;
  let timer = null;
  const history = data.bars;
  const slider = $('replay-position');
  slider.min = '19'; slider.max = String(history.length - 1); slider.value = '119';
  $('replay-marker').textContent = '120 / 120 · full history';
  function setReplay(i, chart = true) {
    if (!Number.isInteger(i) || i < 19 || i >= history.length) return;
    selected = i;
    slider.value = String(i);
    const bar = history[i];
    $('replay-marker').textContent = (i + 1) + ' / 120 · premium ' +
      format(bar.close) + ' · historical simulation';
    if (chart) renderReplay(history.slice(0, i + 1)).catch(e => onStatus(e.message, true));
    updateAlertRows(bar.close, i);
  }
  slider.addEventListener('input', () => {
    const i = Number(slider.value);
    $('replay-marker').textContent = (i + 1) + ' / 120 · preview ' + format(history[i].close);
  });
  slider.addEventListener('change', () => setReplay(Number(slider.value)));
  $('replay-start').addEventListener('click', () => {
    clearInterval(timer);
    timer = null;
    setReplay(19);
    $('replay-play').textContent = 'Play replay';
  });
  $('replay-end').addEventListener('click', () => {
    clearInterval(timer); timer = null;
    setReplay(119);
    $('replay-play').textContent = 'Play replay';
  });
  $('replay-play').addEventListener('click', () => {
    if (timer) {
      clearInterval(timer); timer = null;
      $('replay-play').textContent = 'Play replay';
      return;
    }
    if (selected >= 119) setReplay(19);
    $('replay-play').textContent = 'Pause replay';
    timer = setInterval(() => {
      if (selected >= 119) {
        clearInterval(timer); timer = null;
        $('replay-play').textContent = 'Play replay';
      } else setReplay(selected + 1);
    }, 1000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && timer) {
      clearInterval(timer); timer = null;
      $('replay-play').textContent = 'Play replay';
    }
  });

  function validPosition(record) {
    return record && typeof record.id === 'string'
      && typeof record.signature === 'string'
      && record.status === 'open' && Array.isArray(record.fills)
      && record.fills.length >= 1 && record.fills.length <= 4
      && record.fills.every(f => Number.isFinite(f.fill) && f.fill > 0
        && Number.isInteger(f.qty) && f.qty >= 1 && f.qty <= 5
        && ['CE','PE'].includes(f.type) && ['BUY','SELL'].includes(f.side));
  }
  function paperRows() {
    return readRecords(PKEY).filter(r => r && typeof r.id === 'string'
      && ['open', 'closed'].includes(r.status));
  }
  function showPaper() {
    const panel = $('paper-positions');
    panel.replaceChildren();
    const rows = paperRows();
    const current = marks(data);
    let openCount = 0;
    for (const p of rows.slice().reverse()) {
      const row = node('div', '', 'lab-record');
      const name = node('strong', p.underlying + ' · ' + p.expiry + ' · ' + p.status.toUpperCase());
      const info = node('div', '', 'fine');
      const same = validPosition(p) && p.signature === key;
      if (p.status === 'open') {
        openCount++;
        const simulatedPnl = same ? pnl(p.fills, current) : null;
        info.textContent = 'Entry ' + (Number.isFinite(p.entry_points) ? signed(p.entry_points) : '—') +
          ' pt · ' + (same ? 'Mark P&L ' + signed(simulatedPnl) + ' pt' : 'Select matching strategy to mark');
      } else {
        info.textContent = 'Closed · hypothetical P&L ' +
          (Number.isFinite(p.closed_pnl) ? signed(p.closed_pnl) : '—') + ' pt';
      }
      row.append(name, info);
      if (p.status === 'open' && same) {
        const close = node('button', 'Close paper position', 'secondary');
        close.type = 'button';
        close.addEventListener('click', () => {
          const existing = paperRows();
          const match = existing.find(item => item.id === p.id && item.status === 'open');
          if (!match || !validPosition(match) || match.signature !== key) {
            onStatus('Cannot close a mismatched or invalid paper position.', true);
            return;
          }
          match.status = 'closed';
          match.closed_at = new Date().toISOString();
          match.closed_pnl = Number(pnl(match.fills, marks(data)).toFixed(2));
          store(PKEY, existing);
          showPaper();
          onStatus('Paper position closed locally; no real order was sent.');
        });
        row.append(close);
      }
      panel.append(row);
    }
    if (!rows.length) panel.textContent = 'No simulated paper positions recorded.';
    $('paper-open-count').textContent = String(openCount);
    $('paper-open').disabled = openCount >= MAX_POSITIONS;
  }
  $('paper-open').addEventListener('click', () => {
    try {
      if (selected !== 119) throw new Error('Return replay to latest bar before opening a paper position');
      if (data.trading_enabled !== false || data.broker_connected !== false || data.mode !== 'simulated') {
        throw new Error('Paper orders require explicitly simulated data');
      }
      const quote = marks(data);
      const exposure = quote.reduce((sum, l) => sum + l.fill * l.qty, 0);
      const open = paperRows().filter(r => r.status === 'open');
      if (open.length >= MAX_POSITIONS || exposure > MAX_PREMIUM) {
        throw new Error('Fictional paper risk cap reached; no position opened');
      }
      const id = crypto.randomUUID();
      const entry = quote.reduce((sum, l) =>
        sum + (l.side === 'BUY' ? -1 : 1) * l.qty * l.fill, 0);
      const records = paperRows();
      records.push({
        id, signature: key, status: 'open',
        underlying: config.underlying, expiry: config.expiry,
        fills: quote, entry_points: Number(entry.toFixed(2)),
        created_at: new Date().toISOString(), source: 'simulated-browser-only',
      });
      store(PKEY, records);
      showPaper();
      onStatus('Paper position added to this browser; zero broker requests and zero actual orders.');
    } catch (error) { onStatus(error.message, true); }
  });
  $('paper-clear').addEventListener('click', () => {
    const open = paperRows().some(r => r.status === 'open');
    if (open) {
      onStatus('Close all local paper positions before clearing the journal.', true);
      return;
    }
    localStorage.removeItem(PKEY);
    showPaper();
    onStatus('Browser-only paper journal cleared.');
  });

  function alertRows() {
    return readRecords(AKEY).filter(a => a && a.signature === key
      && Number.isFinite(a.threshold) && a.threshold > 0
      && ['above', 'below'].includes(a.direction));
  }
  function updateAlertRows(price, replayIndex = 119) {
    const panel = $('alert-records');
    panel.replaceChildren();
    const items = alertRows();
    if (!items.length) panel.textContent = 'No foreground simulation alerts yet.';
    let changed = false;
    for (const a of items) {
      if (!a.fired_at && ((a.direction === 'above' && price >= a.threshold)
          || (a.direction === 'below' && price <= a.threshold))) {
        a.fired_at = new Date().toISOString();
        changed = true;
      }
      panel.append(node('div',
        'Premium ' + a.direction + ' ' + format(a.threshold) + ' · ' +
        (a.fired_at ? 'TRIGGERED at replay bar ' + (replayIndex + 1) : 'waiting for this-browser evaluation'),
        a.fired_at ? 'lab-alert triggered' : 'lab-alert'));
    }
    if (changed) {
      const other = readRecords(AKEY).filter(a => a && a.signature !== key);
      store(AKEY, [...other, ...items]);
    }
  }
  $('alert-add').addEventListener('click', () => {
    const threshold = Number($('alert-threshold').value);
    const direction = $('alert-direction').value;
    if (!(threshold > 0 && threshold <= 1_000_000) || !Number.isFinite(threshold)
        || !['above', 'below'].includes(direction)) {
      onStatus('Enter a valid simulated alert price.', true);
      return;
    }
    const rows = readRecords(AKEY);
    if (rows.filter(a => a.signature === key).length >= 8) {
      onStatus('Maximum 8 foreground alerts per strategy.', true);
      return;
    }
    rows.push({ signature: key, direction, threshold, fired_at: null });
    store(AKEY, rows);
    updateAlertRows(history[selected].close, selected);
    onStatus('Browser-only alert added; it is not monitored when this page is closed.');
  });
  $('alert-clear').addEventListener('click', () => {
    store(AKEY, readRecords(AKEY).filter(a => a.signature !== key));
    updateAlertRows(history[selected].close, selected);
  });
  showPaper();
  updateAlertRows(history[selected].close);
}

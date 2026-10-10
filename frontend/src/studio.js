import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';

// Standalone public demo only. Never request or store broker credentials.
// Strategies are reloaded as a single snapshot so chart widgets cannot
// display stale legs after a contract switch.
const $ = id => document.getElementById(id);
const STORE = 'qsyn-studio-workspaces-v1';
const ACTIVE = 'qsyn-studio-active-v1';
const allowed = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];
const expiryCodes = ['W1', 'W2', 'M1'];
const intervals = ['1m', '5m', '15m'];
let state = { underlying: 'NIFTY', expiry: 'W1', interval: '1m', legs: [] };
let market = null;
let currentBars = null;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
const fmt = value => Number(value).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
function validConfig(value) {
  return value && typeof value === 'object'
    && allowed.includes(value.underlying)
    && expiryCodes.includes(value.expiry)
    && intervals.includes(value.interval)
    && Array.isArray(value.legs) && value.legs.length >= 1 && value.legs.length <= 4
    && value.legs.every(l => l && ['CE', 'PE'].includes(l.type)
      && ['BUY', 'SELL'].includes(l.side)
      && Number.isInteger(l.strike) && Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 5);
}
function readJson(key, storage) {
  try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
}
function defaultLegs(atm, step, isStrangle = false) {
  return [
    { type: 'CE', side: 'BUY', strike: atm + (isStrangle ? step : 0), qty: 1 },
    { type: 'PE', side: 'BUY', strike: atm - (isStrangle ? step : 0), qty: 1 },
  ];
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function choose(items, current) {
  const select = document.createElement('select');
  for (const item of items) {
    const opt = new Option(String(item), String(item));
    if (item === current) opt.selected = true;
    select.add(opt);
  }
  return select;
}
function validateCurrent() {
  if (!validConfig(state)) throw new Error('Strategy must contain 1–4 valid demo legs');
  const keys = new Set();
  for (const leg of state.legs) {
    const key = leg.type + ':' + leg.strike;
    if (keys.has(key)) throw new Error('Each CE/PE contract can appear only once in this demo');
    keys.add(key);
    if (!market || Math.abs(leg.strike - market.atm) > market.strike_step * 20
        || leg.strike % market.strike_step !== 0) {
      throw new Error('Strike is outside the simulated instrument range');
    }
  }
}

function renderLegs() {
  const container = $('legs');
  container.replaceChildren();
  state.legs.forEach((leg, index) => {
    const row = element('div', 'leg-row');
    const heading = element('div', 'leg-header');
    heading.append(element('strong', '', 'LEG ' + (index + 1)));
    const remove = element('button', '', 'Remove');
    remove.type = 'button';
    remove.disabled = state.legs.length === 1;
    remove.addEventListener('click', () => {
      state.legs.splice(index, 1);
      renderLegs();
    });
    heading.append(remove);
    const fields = element('div', 'leg-fields');
    const controls = [
      ['Type', choose(['CE', 'PE'], leg.type), 'type'],
      ['Action', choose(['BUY', 'SELL'], leg.side), 'side'],
      ['Strike', choose(market.chain.map(c => c.strike), leg.strike), 'strike'],
    ];
    const qty = document.createElement('input');
    qty.type = 'number'; qty.min = '1'; qty.max = '5'; qty.step = '1';
    qty.value = String(leg.qty);
    controls.push(['Lots*', qty, 'qty']);
    for (const [label, control, key] of controls) {
      const wrapper = element('label', '', label);
      wrapper.append(control);
      fields.append(wrapper);
      control.addEventListener('change', () => {
        leg[key] = key === 'strike' || key === 'qty' ? Number(control.value) : control.value;
        if (key === 'qty' && (!Number.isInteger(leg.qty) || leg.qty < 1 || leg.qty > 5)) {
          status('Quantity must be a whole number from 1 to 5.', true);
        }
      });
    }
    row.append(heading, fields);
    container.append(row);
  });
  $('leg-count').textContent = String(state.legs.length);
  $('add-leg').disabled = state.legs.length >= 4;
}
async function loadMarket(underlying) {
  const response = await fetch('/qsyn/api/v1/studio/market?underlying=' + encodeURIComponent(underlying), {
    cache: 'no-store', credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Fictional option chain unavailable');
  const data = await response.json();
  if (data.mode !== 'simulated' || data.trading_enabled !== false
      || data.broker_connected !== false || data.underlying !== underlying
      || !Array.isArray(data.chain) || data.chain.length < 5) {
    throw new Error('Unsupported studio market provenance');
  }
  market = data;
  $('spot').textContent = fmt(data.spot);
  $('atm').textContent = 'Simulated ATM ' + data.atm.toLocaleString('en-IN')
    + ' · strike step ' + data.strike_step;
  $('chain').replaceChildren();
  for (const quote of data.chain) {
    const row = document.createElement('tr');
    if (quote.strike === data.atm) row.className = 'atm';
    for (const value of [fmt(quote.ce), quote.strike.toLocaleString('en-IN'), fmt(quote.pe)]) {
      row.append(element('td', '', value));
    }
    $('chain').append(row);
  }
}
function sourceFeed(symbol, bars) {
  return {
    async getBars(request) {
      if (request.symbol !== symbol || request.interval !== state.interval) return [];
      return bars;
    },
    // Historical simulated bars only; no WebSocket or polling.
    subscribeBars: () => () => {},
  };
}
async function chart(rootId, symbol, bars) {
  const root = $(rootId);
  root.replaceChildren();
  if (!bars.length || bars.some(b => !(b.low <= Math.min(b.open, b.close)
    && b.high >= Math.max(b.open, b.close)))) {
    throw new Error('Malformed or internally inconsistent demonstration candles');
  }
  const widget = createWidget(root, {
    feed: sourceFeed(symbol, bars), symbol, exchange: 'QSYN',
    interval: state.interval, theme: 'dark',
    navigation: { defaultVisibleBars: 90, mousePan: 'horizontal' },
  });
  await widget.ready;
  return widget;
}
function drawPayoff(points) {
  const canvas = $('payoff');
  const width = Math.max(240, Math.floor(canvas.clientWidth));
  const height = 250;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 48, right: 16, top: 20, bottom: 37 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const vals = points.map(p => p.pnl);
  const absmax = Math.max(20, ...vals.map(Math.abs)) * 1.12;
  const x = i => pad.left + i * w / (points.length - 1);
  const y = value => pad.top + (absmax - value) * h / (2 * absmax);
  ctx.lineWidth = 1; ctx.strokeStyle = '#2b4558';
  for (const fraction of [0, .25, .5, .75, 1]) {
    const yy = pad.top + fraction * h;
    ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(width - pad.right, yy); ctx.stroke();
  }
  ctx.strokeStyle = '#587989';
  ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(width - pad.right, y(0)); ctx.stroke();
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(i), y(p.pnl));
    else ctx.lineTo(x(i), y(p.pnl));
  });
  ctx.lineWidth = 2.5; ctx.strokeStyle = '#6cdec8'; ctx.stroke();
  ctx.fillStyle = '#99b6c8'; ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('+' + fmt(absmax), pad.left - 5, pad.top + 4);
  ctx.fillText('0', pad.left - 5, y(0) + 4);
  ctx.fillText('-' + fmt(absmax), pad.left - 5, pad.top + h + 4);
  ctx.textAlign = 'center';
  for (const idx of [0, Math.floor((points.length - 1) / 2), points.length - 1]) {
    ctx.fillText(String(points[idx].spot), x(idx), height - 14);
  }
}
async function renderStrategy() {
  validateCurrent();
  const query = new URLSearchParams({
    underlying: state.underlying, expiry: state.expiry,
    interval: state.interval, legs: JSON.stringify(state.legs),
  });
  const response = await fetch('/qsyn/api/v1/studio/bars?' + query, {
    cache: 'no-store', credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Strategy rejected by simulated pricing API (' + response.status + ')');
  const data = await response.json();
  if (data.mode !== 'simulated' || data.source !== 'deterministic-options-laboratory'
      || data.trading_enabled !== false || data.broker_connected !== false
      || !Array.isArray(data.bars) || data.bars.length !== 120
      || !Array.isArray(data.legs) || data.legs.length !== state.legs.length
      || data.synthetic_extrema !== 'synchronized_15_second_samples'
      || !Array.isArray(data.payoff) || data.payoff.length !== 21) {
    throw new Error('Pricing API did not provide validated simulated-only data');
  }
  currentBars = data;
  $('premium').textContent = fmt(data.bars.at(-1).close);
  $('entry').textContent = (data.entry_cashflow_points >= 0 ? '+' : '') + fmt(data.entry_cashflow_points);
  $('basket-title').textContent = state.underlying + ' · ' + state.expiry + ' · '
    + state.legs.map(l => l.type + ' ' + l.strike).join(' + ');
  drawPayoff(data.payoff);
  for (let i = 0; i < 2; ++i) {
    if (data.legs[i]) {
      const leg = data.legs[i];
      $('leg-title-' + i).textContent = leg.side + ' ' + leg.qty + ' × '
        + state.underlying + ' ' + leg.strike + ' ' + leg.type;
      await chart('leg-chart-' + i, 'QSYN-LEG-' + i, leg.bars);
    } else {
      $('leg-title-' + i).textContent = 'No second leg';
      $('leg-chart-' + i).textContent = 'Add another simulated leg to compare option charts.';
    }
  }
  await chart('basket-chart', 'QSYN-PREMIUM-DEMO', data.bars);
  status('Loaded 120 synchronized simulated candles · ' + state.interval
    + ' · No live subscription, orders or broker session.');
}

function readSaved() {
  const raw = readJson(STORE, localStorage);
  return Array.isArray(raw) ? raw.filter(x => x && typeof x.name === 'string'
    && x.name.length <= 40 && validConfig(x.config)).slice(-8) : [];
}
function showSaved() {
  $('saved-list').replaceChildren();
  for (const item of readSaved()) {
    const wrapper = element('div', 'save-item');
    wrapper.append(element('span', '', item.name));
    const button = element('button', '', 'Load');
    button.type = 'button';
    button.addEventListener('click', () => apply(item.config));
    wrapper.append(button);
    $('saved-list').append(wrapper);
  }
  if (!$('saved-list').childElementCount) $('saved-list').textContent = 'No layouts saved yet.';
}
function apply(config) {
  try {
    if (!validConfig(config)) throw new Error('Saved strategy is invalid');
    sessionStorage.setItem(ACTIVE, JSON.stringify(config));
    location.reload();
  } catch (error) { status(error.message, true); }
}
function setPreset(strangle) {
  state.legs = defaultLegs(market.atm, market.strike_step, strangle);
  renderLegs();
  status('Strategy updated. Click Render synthetic basket to apply.');
}
async function main() {
  const remembered = readJson(ACTIVE, sessionStorage);
  if (validConfig(remembered)) state = remembered;
  $('underlying').value = state.underlying;
  $('expiry').value = state.expiry;
  $('interval').value = state.interval;
  await loadMarket(state.underlying);
  if (!state.legs.length || state.legs.some(l => !market.chain.some(c => c.strike === l.strike))) {
    state.legs = defaultLegs(market.atm, market.strike_step);
  }
  renderLegs();
  showSaved();
  $('underlying').addEventListener('change', async e => {
    try {
      state.underlying = e.target.value;
      await loadMarket(state.underlying);
      setPreset(false);
    } catch (error) { status(error.message, true); }
  });
  $('expiry').addEventListener('change', e => { state.expiry = e.target.value; });
  $('interval').addEventListener('change', e => { state.interval = e.target.value; });
  $('straddle').addEventListener('click', () => setPreset(false));
  $('strangle').addEventListener('click', () => setPreset(true));
  $('reset').addEventListener('click', () => {
    state.expiry = 'W1'; state.interval = '1m';
    $('expiry').value = state.expiry; $('interval').value = state.interval;
    setPreset(false);
  });
  $('add-leg').addEventListener('click', () => {
    if (state.legs.length >= 4) return;
    const candidate = market.chain.flatMap(c => [
      { type: 'CE', side: 'BUY', strike: c.strike, qty: 1 },
      { type: 'PE', side: 'BUY', strike: c.strike, qty: 1 },
    ]).find(l => !state.legs.some(s => s.type === l.type && s.strike === l.strike));
    if (candidate) state.legs.push(candidate);
    renderLegs();
  });
  $('render').addEventListener('click', () => {
    try { validateCurrent(); apply(state); } catch (error) { status(error.message, true); }
  });
  $('save').addEventListener('click', () => {
    try {
      validateCurrent();
      const name = $('workspace-name').value.trim().slice(0, 40);
      if (!name) throw new Error('Enter a workspace name');
      const items = readSaved().filter(s => s.name !== name);
      items.push({ name, config: JSON.parse(JSON.stringify(state)) });
      localStorage.setItem(STORE, JSON.stringify(items.slice(-8)));
      showSaved();
      status('Workspace saved locally in this browser (not on the server).');
    } catch (error) { status(error.message, true); }
  });
  $('clear-saved').addEventListener('click', () => {
    localStorage.removeItem(STORE);
    showSaved(); status('Browser-only saved workspaces cleared.');
  });
  await renderStrategy();
  window.addEventListener('resize', () => { if (currentBars) drawPayoff(currentBars.payoff); });
}
main().catch(error => {
  console.error('QSYN studio initialization failed', error);
  status('Studio could not load simulated data: ' + error.message, true);
});

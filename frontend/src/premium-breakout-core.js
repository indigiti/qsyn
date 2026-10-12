/**
 * Premium-trigger research engine. Deterministic, read-only, browser-local CSV
 * replay; no broker subscription, order entry, inferred historical fills or OI.
 * Signals use only a COMPLETED bar and enter at the following bar's open.
 */
export const PREMIUM_PRESET = Object.freeze({
  buyAbove: 402, buyStop: 386,
  shortBelow: 386, shortStop: 402,
  directions: 'BOTH', partialR: 3.5,
  volumeMultiplier: 1.5, volumeLookback: 5, useVolume: false, useOi: false,
});

const number = (v) => v !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN;
const whole = (v) => Number.isInteger(v);
const fmtIst = (timestamp) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(timestamp));

export function validatePremiumRules(raw) {
  const v = { ...PREMIUM_PRESET, ...raw };
  for (const k of ['buyAbove','buyStop','shortBelow','shortStop','partialR','volumeMultiplier']) {
    if (!Number.isFinite(v[k]) || v[k] <= 0) throw Error('Invalid positive setting: ' + k);
  }
  if (v.buyStop >= v.buyAbove || v.shortStop <= v.shortBelow)
    throw Error('Stops must be below long triggers and above short triggers.');
  if (v.partialR > 20 || v.volumeMultiplier > 20 ||
      !whole(v.volumeLookback) || v.volumeLookback < 2 || v.volumeLookback > 100 ||
      !['LONG','SHORT','BOTH'].includes(v.directions))
    throw Error('Strategy parameters outside permitted research limits.');
  return v;
}

/** Explicit offset is mandatory; no invented IST or guessed expiry. */
export function parsePremiumCsv(text) {
  if (typeof text !== 'string' || text.length > 2_000_000)
    throw Error('CSV missing or larger than 2 MB.');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 3 || lines.length > 10002) throw Error('CSV requires 2–10,000 candles.');
  const names = lines.shift().toLowerCase().split(',').map(s => s.trim());
  const required = ['time','open','high','low','close','volume'];
  if (!required.every(key => names.includes(key)) || new Set(names).size !== names.length)
    throw Error('CSV header must include time,open,high,low,close,volume; optional oi.');
  const idx = Object.fromEntries(names.map((v, i) => [v, i]));
  let previous = -Infinity;
  return lines.map((line, i) => {
    const cells = line.split(',').map(s => s.trim());
    if (cells.length !== names.length) throw Error('Invalid column count at row ' + (i + 2));
    const raw = cells[idx.time];
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(raw))
      throw Error('Time must be ISO 8601 with timezone offset at row ' + (i + 2));
    const time = Date.parse(raw);
    if (!Number.isFinite(time) || time <= previous ||
        (previous !== -Infinity && time - previous !== 60_000))
      throw Error('Bars must be chronological, contiguous one-minute candles (row ' + (i + 2) + ').');
    previous = time;
    const row = { time };
    for (const key of ['open','high','low','close','volume']) row[key] = number(cells[idx[key]]);
    row.oi = 'oi' in idx && cells[idx.oi] !== '' ? number(cells[idx.oi]) : null;
    if (Object.values(row).some(v => typeof v === 'number' && !Number.isFinite(v)) ||
        row.open <= 0 || row.close <= 0 || row.low <= 0 || row.high < row.low ||
        row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) ||
        row.volume < 0 || (row.oi != null && row.oi < 0))
      throw Error('Invalid OHLCV/OI at row ' + (i + 2));
    const local = fmtIst(time);
    const hm = local.slice(-5), minute = Number(hm.slice(0,2))*60 + Number(hm.slice(3,5));
    if (minute < 9*60+15 || minute >= 15*60+30)
      throw Error('CSV candle outside 09:15–15:29 IST trading window (row ' + (i + 2) + ').');
    return row;
  });
}

function filterOk(bars, signalIndex, v) {
  const trigger = bars[signalIndex];
  if (v.useVolume) {
    if (signalIndex < v.volumeLookback) return false;
    let sum = 0;
    for (let j = signalIndex - v.volumeLookback; j < signalIndex; j++) sum += bars[j].volume;
    if (sum <= 0 || trigger.volume < v.volumeMultiplier * (sum / v.volumeLookback)) return false;
  }
  if (v.useOi) {
    if (signalIndex < 1 || trigger.oi == null || bars[signalIndex-1].oi == null ||
        trigger.oi <= bars[signalIndex-1].oi) return false;
  }
  return true;
}
function sameIstDate(a, b) { return fmtIst(a).slice(0, 10) === fmtIst(b).slice(0, 10); }

/**
 * Conservative, non-lookahead OHLC replay:
 * - signal on completed close, next candle OPEN fill
 * - stop prioritized if both stop and target touched in one candle
 * - 50% scale-out at R multiple, remaining 50% trail by prior completed candle
 * - gaps fill at worse opening price (not a guaranteed stop fill)
 * - open positions do not count as realized winners/losses
 */
export function replayPremiumStrategy(bars, input = PREMIUM_PRESET) {
  const v = validatePremiumRules(input);
  if (!Array.isArray(bars) || bars.length < 2) throw Error('Need at least two option candles.');
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].time > bars[i-1].time && bars[i].time-bars[i-1].time===60000))
      throw Error('Replay requires contiguous ascending one-minute candles.');
  }
  const trades = [];
  let position = null;
  const events = [];
  function exit(side, price, index, reason) {
    const p = position;
    if (!p) return;
    const delta = (price - p.entry) * (side === 'LONG' ? 1 : -1);
    const weight = p.partial ? 0.5 : 1;
    const points = (p.partial ? p.firstPoints : 0) + weight * delta;
    trades.push({
      side, entryTime: p.time, entry: p.entry, stop: p.initialStop,
      firstExit: p.partial?.price ?? null, firstExitTime: p.partial?.time ?? null,
      exitTime: bars[index].time, exit: price, exitReason: reason, points,
      initialRisk: p.risk, r: points / p.risk, signalTime: p.signalTime,
    });
    events.push({type:'EXIT',time:bars[index].time, side, price, reason});
    position = null;
  }
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i], prior = bars[i-1];
    const newDay = !sameIstDate(bar.time, prior.time);
    if (newDay && position) exit(position.side, prior.close, i-1, 'SESSION_END');
    if (!position && !newDay && filterOk(bars, i-1, v)) {
      const long = v.directions !== 'SHORT' && i >= 2 &&
        bars[i-2].close <= v.buyAbove && prior.close > v.buyAbove;
      const short = v.directions !== 'LONG' && i >= 2 &&
        bars[i-2].close >= v.shortBelow && prior.close < v.shortBelow;
      if (long || short) {
        const side = long ? 'LONG' : 'SHORT';
        const initialStop = long ? v.buyStop : v.shortStop;
        const risk = long ? bar.open-initialStop : initialStop-bar.open;
        // Never enter if next-bar open has invalidated the initial stop.
        if (risk > 0) {
          position = {side, entry:bar.open, initialStop, stop:initialStop, risk,
            time:bar.time, signalTime:prior.time, partial:null, firstPoints:0};
          events.push({type:'ENTRY',time:bar.time,side,price:bar.open});
        } else events.push({type:'REJECTED_GAP',time:bar.time,side,price:bar.open});
      }
    }
    if (!position) continue;
    const p = position, long = p.side === 'LONG';
    const stopTouched = long ? bar.low <= p.stop : bar.high >= p.stop;
    if (stopTouched) {
      const fill = long ? Math.min(p.stop,bar.open) : Math.max(p.stop,bar.open);
      exit(p.side, fill, i, 'STOP');
      continue;
    }
    if (!p.partial) {
      const target = p.entry + (long ? 1 : -1) * v.partialR * p.risk;
      if (long ? bar.high >= target : bar.low <= target) {
        const fill = long ? Math.max(target,bar.open) : Math.min(target,bar.open);
        p.partial = {price:fill,time:bar.time};
        p.firstPoints = 0.5 * (fill - p.entry) * (long ? 1 : -1);
        events.push({type:'HALF_EXIT',time:bar.time,side:p.side,price:fill});
      }
    } else {
      // Prior completed candle only. Never widen stop or override initial risk.
      p.stop = long ? Math.max(p.stop,prior.low) : Math.min(p.stop,prior.high);
    }
    // Never carry across the end of the regular session.
    if (fmtIst(bar.time).endsWith('15:29') && position) exit(p.side,bar.close,i,'SESSION_END');
  }
  const realized = trades.reduce((s,t)=>s+t.points,0);
  const wins = trades.filter(t=>t.points>0);
  const losses = trades.filter(t=>t.points<0);
  return {
    schema:'QSYN-PREMIUM-RESEARCH/1', source:'user_supplied_csv', trading_enabled:false,
    trades, events, openPosition:position ? {
      side:position.side, entry:position.entry, stop:position.stop, time:position.time,
      partial:position.partial, unrealizedAtLastClose:
        (bars.at(-1).close-position.entry)*(position.side==='LONG'?1:-1),
    } : null,
    summary: {completed:trades.length, wins:wins.length, losses:losses.length,
      winRate:trades.length ? wins.length/trades.length : null, realizedPoints:realized,
      avgR:trades.length ? trades.reduce((s,t)=>s+t.r,0)/trades.length : null},
  };
}

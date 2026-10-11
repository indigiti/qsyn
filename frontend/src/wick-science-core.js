/**
 * Wick Science - Multi-TF MFE Flip (Open Reversal).
 * Deterministic Pine v6 rule port: no broker IO, no realtime side effects.
 * Market bars are UTC-second opening times, sorted in ascending order.
 *
 * Signals only occur on CONFIRMED lower-timeframe candles. Partial and
 * gapped setup candles cannot enter historical MFE windows.
 * No signal is fabricated when both zones touch on the same lower-TF candle.
 */
const EVENT_KEYS = Object.freeze([
  'shortArmed','longArmed','shortEntry','longEntry',
  'shortTP','longTP','shortSL','longSL',
]);
export const WICK_SCIENCE_ID = 'qsyn-wick-science-mfe-flip';
export const WICK_EVENTS = EVENT_KEYS;

function nullResults(n) {
  const result = {};
  for (const key of ['setupOpen','upperZone','lowerZone','activeStop',...EVENT_KEYS]) {
    result[key] = Array(n).fill(null);
  }
  return result;
}
function intervalSeconds(value) {
  const match = /^(\d+)(s|m|h)$/.exec(String(value || ''));
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) && amount > 0
    ? amount * ({s:1,m:60,h:3600})[match[2]]
    : null;
}
function nearestRank(sortedValues, rate) {
  // Pine ta.percentile_nearest_rank(v, samples, percentile).
  const rank = Math.max(1, Math.ceil(sortedValues.length * rate / 100));
  return sortedValues[rank - 1];
}
function rollingReach(history, samples, reachRate) {
  if (history.length < samples) return null;
  const window = history.slice(-samples).sort((a,b) => a-b);
  return nearestRank(window, 100 - reachRate);
}
function emptyWithReason(bars, reason) {
  return {values:nullResults(bars.length), reason};
}

/**
 * @param {Array<{time:number,open:number,high:number,low:number,close:number}>} bars
 * @param {object} settings setupTf ('1'/'3'/'5'/'15') is in minutes
 * @param {object} context {interval:'1m', lastConfirmed:false, tickSize:0.05}
 */
export function calculateWickScience(bars, settings = {}, context = {}) {
  if (!Array.isArray(bars)) throw new TypeError('bars must be an array');
  const values = nullResults(bars.length);
  const selectedMinutes = Number(settings.setupTf ?? '5');
  const setupSeconds = selectedMinutes * 60;
  const chartSeconds = intervalSeconds(context.interval);
  const samples = Number(settings.samples ?? 100);
  const reachRate = Number(settings.reachRate ?? 80);
  const fraction = Number(settings.zoneFraction ?? 80) / 100;
  const buffer = Number(settings.slBuffer ?? 2);
  const tickSize = Number(context.tickSize);
  if (![1,3,5,15].includes(selectedMinutes) || !chartSeconds || chartSeconds >= setupSeconds
      || setupSeconds % chartSeconds !== 0) return {values,reason:'chart_timeframe_must_be_lower'};
  if (!Number.isInteger(samples) || samples < 20 || samples > 1000
      || !Number.isFinite(reachRate) || reachRate < 50 || reachRate > 99
      || !Number.isFinite(fraction) || fraction < 0.1 || fraction > 1
      || !Number.isInteger(buffer) || buffer < 0 || buffer > 100) {
    return {values,reason:'invalid_settings'};
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return {values,reason:'instrument_tick_size_unavailable'};
  }
  const expected = setupSeconds / chartSeconds;
  const ups = [], downs = [];
  let group = null, state = 0, armIndex = -1, entryIndex = -1;
  let wickExtreme = null, activeStop = null;
  let setupOpen = null, upperZone = null, lowerZone = null;
  let available = false;

  function finalizePreviousGroup() {
    if (group && group.count === expected
        && group.first === group.bucket
        && group.last === group.bucket + setupSeconds - chartSeconds
        && group.unbroken) {
      ups.push(group.high - group.open);
      downs.push(group.open - group.low);
    } else {
      // Never use a rolling history window that silently bridges missing or
      // partial higher-timeframe candles.
      ups.length = 0;
      downs.length = 0;
    }
  }
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar || !Number.isSafeInteger(bar.time) || bar.time <= 0 ||
        bar.time % chartSeconds !== 0 || (i > 0 && bar.time <= bars[i-1].time)
        || !['open','high','low','close'].every(key => Number.isFinite(bar[key]))
        || bar.high < Math.max(bar.open,bar.close) ||
        bar.low > Math.min(bar.open,bar.close)) {
      return {values:nullResults(bars.length),reason:'invalid_or_unsorted_bars'};
    }
    const bucket = Math.floor(bar.time / setupSeconds) * setupSeconds;
    if (!group || bucket !== group.bucket) {
      if (group) finalizePreviousGroup();
      group = { bucket, first:bar.time, last:bar.time, count:0,
        unbroken:true, open:bar.open, high:bar.high, low:bar.low };
      setupOpen = bar.time === bucket ? bar.open : null;
      const up = rollingReach(ups,samples,reachRate);
      const down = rollingReach(downs,samples,reachRate);
      upperZone = setupOpen === null || up === null ? null : setupOpen + up*fraction;
      lowerZone = setupOpen === null || down === null ? null : setupOpen - down*fraction;
      available = upperZone !== null && lowerZone !== null &&
        upperZone > setupOpen && lowerZone < setupOpen;
      state = 0; armIndex = -1; entryIndex = -1; wickExtreme = null; activeStop = null;
    } else if (group.count > 0 && bar.time !== group.last + chartSeconds) {
      // We cannot reconstruct a flip sequence across a missing lower-TF bar.
      // Disable trading signals for this entire higher-TF candle, not merely
      // the MFE contribution when it eventually closes.
      group.unbroken = false;
      available = false;
      state = 6;
    }
    group.last = bar.time;
    group.count++;
    group.high = Math.max(group.high,bar.high);
    group.low = Math.min(group.low,bar.low);
    values.setupOpen[i] = setupOpen;
    values.upperZone[i] = upperZone;
    values.lowerZone[i] = lowerZone;

    const confirmed = i < bars.length - 1 || context.lastConfirmed === true;
    if (available && confirmed) {
      if (state === 0) {
        const upperTouched = bar.high >= upperZone;
        const lowerTouched = bar.low <= lowerZone;
        if (upperTouched && lowerTouched) state = 6;
        else if (upperTouched) {
          state = 1; armIndex = i; wickExtreme = bar.high; values.shortArmed[i] = 1;
        } else if (lowerTouched) {
          state = 2; armIndex = i; wickExtreme = bar.low; values.longArmed[i] = 1;
        }
      } else if (state === 1) {
        if (i > armIndex && bar.open >= setupOpen && bar.low <= setupOpen) {
          activeStop = Math.max(wickExtreme,bar.open) + buffer*tickSize;
          entryIndex = i; state = 3; values.shortEntry[i] = 1;
        } else wickExtreme = Math.max(wickExtreme,bar.high);
      } else if (state === 2) {
        if (i > armIndex && bar.open <= setupOpen && bar.high >= setupOpen) {
          activeStop = Math.min(wickExtreme,bar.open) - buffer*tickSize;
          entryIndex = i; state = 4; values.longEntry[i] = 1;
        } else wickExtreme = Math.min(wickExtreme,bar.low);
      } else if (state === 3 && i > entryIndex) {
        if (bar.high >= activeStop) {state = 5; values.shortSL[i] = 1;}
        else if (bar.low <= lowerZone) {state = 5; values.shortTP[i] = 1;}
      } else if (state === 4 && i > entryIndex) {
        if (bar.low <= activeStop) {state = 5; values.longSL[i] = 1;}
        else if (bar.high >= upperZone) {state = 5; values.longTP[i] = 1;}
      }
    }
    // Match Pine: no stop line on the candle that completed the trade.
    values.activeStop[i] = state === 3 || state === 4 ? activeStop : null;
  }
  const reason = ups.length >= samples && downs.length >= samples
    ? null : 'insufficient_completed_setup_history';
  return {values,reason};
}

// Prevent a stored Upstox Analytics Token or static symbol catalog from
// being misrepresented as verified historical candles or a working live feed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=(name)=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const panel=source('terminal-unified.jsx');
const explorer=source('market-explorer.jsx');
const chart=source('private-index-history-chart.jsx');
assert.ok(panel.includes('historical candles and live ticks not yet verified'));
assert.ok(!panel.includes('Personal chart data is ready'));
assert.ok(!panel.includes('1m OHLC available'));
assert.ok(explorer.includes("local catalog, not a live Upstox lookup"));
assert.ok(explorer.includes('A stored Analytics Token does not confirm available candles'));
for(const code of [
  'QSYN_ADMIN_LOGIN_REQUIRED','UPSTOX_CHART_ACCESS_DENIED',
  'UPSTOX_HISTORY_PROOF_UNAVAILABLE','UPSTOX_ANALYTICS_TOKEN_NOT_READY',
  'QSYN_CHART_SESSION_NOT_READY'
]) assert.ok(chart.includes(code),'missing safe diagnostic '+code);
assert.ok(chart.includes("Check Data Providers → Upstox Token."));
console.log('PASS: Upstox catalog, token and live data are independently disclosed');

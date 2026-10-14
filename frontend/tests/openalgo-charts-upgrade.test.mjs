// OpenAlgo Charts 2.6.4 changes widget navigation defaults. Audit *every*
// QSYN widget/grid mount, not just the homepage, before upgrading production.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => readFileSync(resolve(root, path), 'utf8');
const pkg = JSON.parse(load('package.json'));
assert.equal(pkg.dependencies['openalgo-charts'], '2.6.4', 'candidate must be precisely pinned');

// Fixture documents every actual chart consumer including the non-homepage
// studio, strategy, private chart and single-grid mounts. Any newly added
// consumer fails CI until navigation policy has explicitly been reviewed.
const expected = new Map([
  ['src/main.js', 1],
  ['src/account-chart.js', 1],
  ['src/studio.js', 1],
  ['src/terminal-strategy.jsx', 1],
  ['src/private-index-history-chart.jsx', 1],
  ['src/terminal.jsx', 3],
]);
function* sources(dir) {
  for (const item of readdirSync(dir)) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(?:js|jsx|mjs)$/.test(item)) yield relative(root, path).split('\\').join('/');
  }
}
const discovered = new Map();
let total = 0;
for (const path of sources(resolve(root, 'src'))) {
  const source = load(path);
  const count = [...source.matchAll(/\b(?:createWidget|createChartGrid)\s*\(/g)].length;
  if (count === 0) continue;
  discovered.set(path, count);
  total += count;
  const anchors = [...source.matchAll(/\bzoomAnchor\s*:\s*['"]cursor['"]/g)].length;
  const panModes = [...source.matchAll(/\bmousePan\s*:\s*['"](?:horizontal|both)['"]/g)].length;
  assert.equal(anchors, count, `${path}: every widget/grid requires explicit cursor-anchored zoom`);
  assert.equal(panModes, count, `${path}: every widget/grid requires explicit pre-upgrade mouse pan policy`);
}
assert.deepEqual([...discovered].sort(), [...expected].sort(),
  'New or missing chart mounts must be reviewed before enabling the new chart version');
assert.equal(total, 8, 'all eight QSYN chart mounts must be guarded');

// The private market chart had no pre-upgrade override: 2.6.0 allowed price
// dragging too. All other entrypoints intentionally used horizontal drag.
const terminal = load('src/terminal.jsx');
const privatePanel = terminal.slice(terminal.indexOf('function PrivateMarketPanel('));
assert.match(privatePanel, /navigation\s*:\s*\{\s*mousePan\s*:\s*['"]both['"]\s*\}/,
  'Private market drag behavior must not silently change to horizontal');
assert.equal([...terminal.matchAll(/\bmousePan\s*:\s*['"]both['"]/g)].length, 1,
  'Only the previously unconfigured private market widget should drag the price scale');

const upstreamLock = JSON.parse(readFileSync(resolve(root, '..', 'ops/openalgo/upstream.lock.json'), 'utf8'));
assert.equal(upstreamLock.commit, '12e1114657981a3e50dde8c8ce04eb778ae1cf2f',
  'Do not silently upgrade the separately deployed native OpenAlgo application');
assert.equal(upstreamLock.frontend_openalgo_charts, '2.6.0',
  'Native OpenAlgo remains pinned; this candidate upgrades only QSYN frontend');
console.log('PASS: eight QSYN chart mounts preserve cursor zoom, drag policy, and isolated 2.6.4 dependency');

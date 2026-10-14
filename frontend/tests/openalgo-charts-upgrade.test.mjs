// Dependency-candidate guard: OpenAlgo Charts 2.6.3 changed widget zoomAnchor
// from cursor to right. Keep the existing QSYN behavior until UX-approved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => readFileSync(resolve(root, path), 'utf8');
const pkg = JSON.parse(load('package.json'));
assert.equal(pkg.dependencies['openalgo-charts'], '2.6.4', 'chart candidate must remain precisely pinned');

const required = [
  ['src/main.js', 1],
  ['src/account-chart.js', 1],
  ['src/private-index-history-chart.jsx', 1],
  ['src/terminal.jsx', 3],
];
for (const [path, count] of required) {
  const source = load(path);
  const anchors = [...source.matchAll(/zoomAnchor\s*:\s*['\"]cursor['\"]/g)];
  assert.equal(anchors.length, count, `${path}: require explicit cursor zoom on every widget/grid chart`);
  assert.ok(source.includes("mousePan: 'horizontal'") || source.includes("mousePan:'horizontal'") || path === 'src/terminal.jsx',
    `${path}: keep the existing horizontal drag behavior`);
}
const upstreamLock = JSON.parse(readFileSync(resolve(root, '..', 'ops/openalgo/upstream.lock.json'), 'utf8'));
assert.equal(upstreamLock.commit, '12e1114657981a3e50dde8c8ce04eb778ae1cf2f',
  'Do not change native OpenAlgo application pin in a Charts candidate');
assert.equal(upstreamLock.frontend_openalgo_charts, '2.6.0',
  'Do not silently alter the separately packaged native OpenAlgo foundation');
console.log('QSYN OpenAlgo Charts 2.6.4 candidate navigation and pin contract passed');

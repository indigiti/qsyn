// Guard the two deployed frontend entry points against legacy bundle regrowth.
// Standalone Studio and Rust admin pages are PHP redirect shims; the React
// terminal owns their interfaces. The Rust demo feed still belongs to the
// supported simulated ChartWorkspace and must NOT be removed.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const at=path=>resolve(root,path);
const pkg=JSON.parse(readFileSync(at('frontend/package.json'),'utf8'));
assert.ok(pkg.scripts.build.includes('src/terminal.jsx'),'missing terminal entry');
assert.ok(pkg.scripts.build.includes('src/account-chart.js'),'missing mock account entry');
for(const entry of ['src/main.js','src/studio.js','dist/chart.js','dist/studio.js'])
  assert.ok(!pkg.scripts.build.includes(entry),'retired build target '+entry);
for(const path of [
  "frontend/src/main.js",
  "frontend/src/studio.js",
  "frontend/src/studio-lab.js",
  "apps/web-php/public/assets/studio.css",
  "apps/web-php/public/assets/rust-diagnostics.js",
  "apps/web-php/public/assets/chart-diagnostics.js",
  "apps/web-php/public/assets/rust-stream-test.js",
  "apps/web-php/public/assets/rust-admin.js",
  "apps/web-php/public/assets/rust-activation-readiness.js"
])
  assert.ok(!existsSync(at(path)),'obsolete UI file returned: '+path);
const release=readFileSync(at('.github/workflows/release.yml'),'utf8');
for(const name of ["rust-diagnostics.js","chart-diagnostics.js","rust-stream-test.js","rust-admin.js","rust-activation-readiness.js"]) {
  assert.ok(!release.includes('cp apps/web-php/public/assets/'+name), 'obsolete asset shipped '+name);
  assert.ok(release.includes('test ! -e staging/public/assets/'+name), 'missing release guard '+name);
  assert.ok(release.includes('test ! -e verified-release/public/assets/'+name), 'missing artifact guard '+name);
}
for(const path of ['frontend/src/terminal.jsx','frontend/src/rust-demo-feed.js','frontend/src/terminal-feed.js',
  'apps/web-php/public/studio.php','apps/web-php/public/admin-rust.php',
  'apps/web-php/public/terminal-routes.json'])
  assert.ok(existsSync(at(path)),'required active/compatibility asset removed: '+path);
console.log('PASS: production routes use only maintained terminal/account chart entrypoints');

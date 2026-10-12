import assert from 'node:assert/strict';
import {terminalRoutes,terminalAliases,terminalHref,
  terminalViewForLocation,legacyTerminalTarget,defaultTerminalView
} from '../src/terminal-routes.js';

assert.equal(defaultTerminalView,'markets');
assert.equal(terminalRoutes.length,11);
assert.equal(new Set(terminalRoutes.map(x=>x.href)).size,terminalRoutes.length);
for(const route of terminalRoutes) {
  assert.equal(terminalHref(route.view),route.href);
  assert.equal(terminalViewForLocation(route.href),route.view);
  assert.equal(terminalViewForLocation(route.href+'/'),route.view);
}
assert.equal(terminalHref('secret-internal'),null);
assert.equal(terminalViewForLocation('/qsyn/terminal'),'markets');
assert.equal(terminalViewForLocation('/qsyn/terminal','?view=strategy'),'strategy');
assert.equal(terminalViewForLocation('/qsyn/terminal/','?view=operations'),'operations');
assert.equal(terminalViewForLocation('/qsyn/terminal','?view=../evil'),'markets');
assert.equal(terminalViewForLocation('/qsyn/terminal/unknown'),null);
assert.equal(terminalViewForLocation('/qsyn/terminal/markets/more'),null);
assert.equal(terminalViewForLocation('/qsyn/api/v1/admin/rust/action'),null);
assert.equal(terminalViewForLocation('/qsyn/'),null);
assert.equal(terminalAliases.length,3);
for(const alias of terminalAliases) {
  assert.equal(legacyTerminalTarget(alias.path),alias.href);
  assert.equal(legacyTerminalTarget(alias.path+'/'),alias.href);
}
assert.equal(legacyTerminalTarget('https://evil.example/'),null);
assert.equal(terminalRoutes.find(x=>x.view==='operations')?.access,'admin-gated');
assert.equal(terminalRoutes.find(x=>x.view==='private-live')?.access,'account-gated');
console.log('PASS: Canonical React URLs, shared route catalog, aliases and API/unknown-page isolation');

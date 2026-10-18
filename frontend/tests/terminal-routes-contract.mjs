import assert from 'node:assert/strict';
import {terminalRoutes,terminalAliases,terminalHref,
  terminalViewForLocation,legacyTerminalTarget,defaultTerminalView
} from '../src/terminal-routes.js';

assert.equal(defaultTerminalView,'dashboard');
assert.equal(terminalRoutes.length,8);
assert.equal(new Set(terminalRoutes.map(x=>x.href)).size,terminalRoutes.length);
for(const route of terminalRoutes) {
  assert.equal(terminalHref(route.view),route.href);
  assert.equal(terminalViewForLocation(route.href),route.view);
  assert.equal(terminalViewForLocation(route.href+'/'),route.view);
}
assert.equal(terminalHref('secret-internal'),null);
assert.equal(terminalViewForLocation('/qsyn/terminal'),'dashboard');
assert.equal(terminalViewForLocation('/qsyn/terminal','?view=strategy'),'strategy');
assert.equal(terminalViewForLocation('/qsyn/terminal/','?view=operations'),'operations');
assert.equal(terminalViewForLocation('/qsyn/terminal','?view=../evil'),'dashboard');
assert.equal(terminalViewForLocation('/qsyn/terminal/unknown'),null);
assert.equal(terminalViewForLocation('/qsyn/terminal/markets/more'),null);
assert.equal(terminalViewForLocation('/qsyn/api/v1/admin/rust/action'),null);
assert.equal(terminalViewForLocation('/qsyn/'),null);
assert.equal(terminalAliases.length,6);
for(const alias of terminalAliases) {
  assert.equal(legacyTerminalTarget(alias.path),alias.href);
  assert.equal(legacyTerminalTarget(alias.path+'/'),alias.href);
}
for(const [retired,destination] of [['trading','workspaces'],['tools','markets'],['routes','diagnostics']]){
  assert.equal(terminalHref(retired),null);
  assert.equal(terminalViewForLocation('/qsyn/terminal/'+retired),null);
  assert.equal(legacyTerminalTarget('/qsyn/terminal/'+retired),terminalHref(destination));
}
assert.equal(legacyTerminalTarget('https://evil.example/'),null);
assert.equal(terminalRoutes.find(x=>x.view==='operations')?.access,'admin-gated');
assert.equal(terminalRoutes.find(x=>x.view==='private-live')?.access,'account-gated');
console.log('PASS: Canonical React URLs, shared route catalog, aliases and API/unknown-page isolation');

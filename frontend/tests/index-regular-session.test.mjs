import test from 'node:test';
import assert from 'node:assert/strict';
import {inRegularIndexSession} from '../src/index-regular-session.js';

const ist=local=>new Date(local+'+05:30');

test('regular 1-minute Indian index session opens exactly 09:15 IST',()=>{
  assert.equal(inRegularIndexSession(ist('2026-10-12T09:14:59')),false);
  assert.equal(inRegularIndexSession(ist('2026-10-12T09:15:00')),true);
  assert.equal(inRegularIndexSession(ist('2026-10-12T12:00:00')),true);
  assert.equal(inRegularIndexSession(ist('2026-10-12T15:29:59')),true);
  assert.equal(inRegularIndexSession(ist('2026-10-12T15:30:00')),false);
  assert.equal(inRegularIndexSession(ist('2026-10-12T19:43:59')),false);
});
test('never reconnect during regular-session weekend gaps',()=>{
  assert.equal(inRegularIndexSession(ist('2026-10-10T11:00:00')),false);
  assert.equal(inRegularIndexSession(ist('2026-10-11T11:00:00')),false);
  assert.equal(inRegularIndexSession(ist('2026-10-09T11:00:00')),true);
});
test('session hours remain IST regardless of host timezone and UTC day',()=>{
  assert.equal(inRegularIndexSession(new Date('2026-10-12T03:44:00Z')),false);
  assert.equal(inRegularIndexSession(new Date('2026-10-12T03:45:00Z')),true);
  assert.equal(inRegularIndexSession(new Date('2026-10-12T10:00:00Z')),false);
});

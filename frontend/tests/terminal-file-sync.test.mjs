import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPrivateWorkspace, savePrivateWorkspace
} from '../src/terminal-file-sync.js';
import { defaultWorkspace } from '../src/terminal-workspace.js';

const csrf = 'a'.repeat(64);
const initial = {
  mode: 'simulated', storage: 'private_file_development_only',
  revision: 0, csrf, can_write: true, workspace: defaultWorkspace(),
};
const response = (status, value) => ({
  status, ok: status >= 200 && status < 300, json: async () => value,
});

test('private sync remains unavailable without authenticated private endpoint', async () => {
  assert.equal((await checkPrivateWorkspace(async () => response(503, {}))).status, 'disabled');
  assert.equal((await checkPrivateWorkspace(async () => response(401, {}))).status, 'login_required');
  assert.equal((await checkPrivateWorkspace(async () => { throw Error('offline'); })).status, 'offline');
  assert.equal((await checkPrivateWorkspace(async () => response(200, {
    ...initial, storage: 'public_database',
  }))).status, 'offline');
});
test('private state is validated and fetched same-origin with no external credentials', async () => {
  const received = [];
  const state = await checkPrivateWorkspace((path, args) => {
    received.push({ path, args });
    return response(200, initial);
  });
  assert.equal(state.status, 'ready');
  assert.equal(state.revision, 0);
  assert.equal(state.canWrite, true);
  assert.deepEqual(state.workspace, defaultWorkspace());
  assert.equal(received[0].path, '/qsyn/api/v1/terminal/workspace');
  assert.equal(received[0].args.credentials, 'same-origin');
});
test('explicit private file save includes only CSRF, revision and bounded workspace', async () => {
  const remote = await checkPrivateWorkspace(async () => response(200, initial));
  const calls = [];
  const updated = await savePrivateWorkspace((path, options) => {
    calls.push({ path, options });
    return response(200, {
      mode: 'simulated', storage: 'private_file_development_only',
      revision: 1, workspace: defaultWorkspace(),
    });
  }, remote, defaultWorkspace());
  assert.equal(updated.revision, 1);
  const saved = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(saved).sort(), ['expected_revision', 'workspace']);
  assert.equal(saved.expected_revision, 0);
  assert.equal(calls[0].options.headers['X-CSRF-Token'], csrf);
  assert.equal(calls[0].options.credentials, 'same-origin');
  for (const key of ['tenant', 'owner', 'user_id', 'broker', 'account_id', 'token']) {
    assert.ok(!calls[0].options.body.includes('"'+key+'"'));
  }
});
test('revision conflicts and viewer access prevent writes', async () => {
  await assert.rejects(savePrivateWorkspace(
    async () => response(409, {}), {
      status: 'ready', canWrite: true, revision: 1, csrf,
    }, defaultWorkspace()), /changed in another tab/);
  await assert.rejects(savePrivateWorkspace(
    async () => response(200, {}), {
      status: 'ready', canWrite: false, revision: 0, csrf,
    }, defaultWorkspace()), /not authorized/);
});

'use strict';

const api = '/qsyn/api/v1/admin/rust';
const byId = id => document.getElementById(id);
const loginBox = byId('admin-login');
const panel = byId('admin-panel');
const form = byId('login-form');
const password = byId('admin-password');
const feedback = byId('feedback');
const loginHelp = byId('login-help');
const managerStatus = byId('manager-status');
const actions = ['start','stop','restart'];
let csrf = '';
let working = false;

async function request(path, data, token) {
  const opts = {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  };
  if (data !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    if (token) opts.headers['X-CSRF-Token'] = token;
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(api + '/' + path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'request_failed');
  return body;
}

function showManager(manager) {
  const ready = Boolean(manager && manager.available);
  const state = (manager && manager.state) || 'unavailable';
  managerStatus.textContent = ready ? state : 'Unavailable — requires enabled direct mode or restricted service manager';
  for (const action of actions) {
    byId('service-' + action).disabled = working || !ready;
  }
}

async function loadState() {
  const state = await request('state');
  loginBox.hidden = state.authenticated;
  panel.hidden = !state.authenticated;
  if (!state.configured) {
    loginHelp.textContent = 'Admin control is disabled. The server operator must configure QSYN_CONTROL_ENABLED and an administrator password hash.';
    form.hidden = true;
  } else {
    loginHelp.textContent = 'Sign in with the dedicated QSYN administrator password.';
    form.hidden = false;
  }
  csrf = state.authenticated ? state.csrf : '';
  showManager(state.manager);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  feedback.textContent = '';
  byId('login-button').disabled = true;
  try {
    const state = await request('login', {password: password.value});
    csrf = state.csrf;
    password.value = '';
    await loadState();
    feedback.textContent = 'Administrator session active.';
  } catch (error) {
    feedback.textContent = 'Sign-in failed or disabled: ' + error.message;
  } finally {
    byId('login-button').disabled = false;
  }
});

for (const action of actions) {
  byId('service-' + action).addEventListener('click', async () => {
    if (working || !csrf) return;
    if ((action === 'stop' || action === 'restart') &&
        !confirm('Confirm ' + action.toUpperCase() + ' for qsyn-stream? Active chart feeds may be interrupted.')) return;
    working = true;
    feedback.textContent = 'Requesting ' + action + '…';
    for (const item of actions) byId('service-' + item).disabled = true;
    try {
      await request('action', {action}, csrf);
      feedback.textContent = action.toUpperCase() + ' request accepted. Refresh health to confirm final state.';
    } catch (error) {
      feedback.textContent = 'Could not execute action: ' + error.message;
    } finally {
      working = false;
      await loadState().catch(() => {});
    }
  });
}

byId('logout').addEventListener('click', async () => {
  try {
    await request('logout', {}, csrf);
    csrf = '';
    await loadState();
    feedback.textContent = 'Signed out.';
  } catch (error) {
    feedback.textContent = 'Sign out failed.';
  }
});

byId('service-refresh').addEventListener('click', async () => {
  try { await loadState(); } catch (error) { feedback.textContent = 'Status temporarily unavailable.'; }
});

byId('probe-rust').addEventListener('click', async () => {
  const target = byId('probe-result');
  target.textContent = 'Checking…';
  try {
    const r = await fetch('/qsyn/api/v1/diagnostics/rust', {credentials:'same-origin',cache:'no-store'});
    if (!r.ok) throw Error('health_endpoint_unavailable');
    const data = await r.json();
    target.textContent = data.status === 'online'
      ? 'Online · ' + data.latency_ms + ' ms · WS: ' + data.websocket
      : 'Offline or invalid (' + data.status + ')';
  } catch (error) {
    target.textContent = 'Health check unavailable';
  }
});

loadState().catch(() => { feedback.textContent = 'Admin API unavailable. Verify the deployed release.'; });
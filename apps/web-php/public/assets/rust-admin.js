'use strict';

const api = '/qsyn/api/v1/admin/rust';
const byId = id => document.getElementById(id);
const loginBox = byId('admin-login');
const setupBox = byId('admin-first-run');
const setupForm = byId('setup-form');
let setupCsrf = '';
const panel = byId('admin-panel');
const form = byId('login-form');
const password = byId('admin-password');
const feedback = byId('feedback');
const loginHelp = byId('login-help');
const managerStatus = byId('manager-status');
const actions = ['start','stop','restart'];
let csrf = '';
let working = false;
let demoWorking = false;

function updateDemoControls(ready, enabled) {
  byId('demo-enable').disabled = demoWorking || !ready || enabled === true;
  byId('demo-disable').disabled = demoWorking || !ready || enabled !== true;
}

async function loadDemoState() {
  const result = await request('demo');
  const ready = result.engine_online && result.supported && result.writable;
  if (!result.engine_online) {
    byId('demo-mode').textContent = 'Rust offline';
    byId('demo-mode-help').textContent = 'Start the Rust engine before changing its streaming mode.';
  } else if (!result.supported) {
    byId('demo-mode').textContent = 'Running older Rust binary';
    byId('demo-mode-help').textContent = 'Deploy the updated Rust binary and restart the existing process once. Further demo toggles then work from the browser.';
  } else if (!result.writable) {
    byId('demo-mode').textContent = 'Private runtime not writable';
    byId('demo-mode-help').textContent = 'Cloudways must grant the QSYN PHP application write access to its private runtime directory.';
  } else {
    byId('demo-mode').textContent = result.enabled ? 'Enabled (simulated data)' : 'Disabled';
    byId('demo-mode-help').textContent = 'Changes apply to the next WebSocket connection without restarting Rust.';
  }
  updateDemoControls(ready, result.enabled);
}


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
  setupCsrf = !state.configured && state.setup?.available ? state.setup.csrf : '';
  setupBox.hidden = !setupCsrf;
  loginBox.hidden = state.authenticated || Boolean(setupCsrf);
  panel.hidden = !state.authenticated;
  if (!state.configured) {
    loginHelp.textContent = 'Admin sign-in is not configured. If first-run setup is available, use the private setup code shown in the Cloudways file manager. Otherwise ask the QSYN operator to check private runtime permissions.';
    form.hidden = true;
  } else {
    loginHelp.textContent = 'Sign in with the dedicated QSYN administrator password.';
    form.hidden = false;
  }
  csrf = state.authenticated ? state.csrf : '';
  byId('demo-config').hidden = !state.authenticated;
  showManager(state.manager);
  if (state.authenticated) {
    await loadDemoState();
  }
}

setupForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!setupCsrf) return;
  const code = byId('setup-code');
  const fresh = byId('setup-password');
  const confirm = byId('setup-confirm');
  if (fresh.value !== confirm.value || fresh.value.length < 20) {
    feedback.textContent = 'Passwords must match and contain at least 20 characters.';
    return;
  }
  const button = byId('setup-button');
  button.disabled = true;
  feedback.textContent = 'Creating private QSYN administrator configuration…';
  try {
    await request('setup', {setup_code: code.value.trim(), new_password: fresh.value}, setupCsrf);
    feedback.textContent = 'Administrator password created. Sign in with your new password.';
    code.value = '';
    fresh.value = '';
    confirm.value = '';
    await loadState();
  } catch (_error) {
    feedback.textContent = 'First-time setup could not be completed. Verify the private pairing code, runtime permissions, and HTTPS connection.';
  } finally {
    button.disabled = false;
  }
});

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

for (const [action, enabled] of [['enable', true], ['disable', false]]) {
  byId('demo-' + action).addEventListener('click', async () => {
    if (demoWorking || !csrf) return;
    demoWorking = true;
    feedback.textContent = 'Updating simulated feed…';
    updateDemoControls(false, false);
    try {
      await request('demo', {enabled}, csrf);
      feedback.textContent = enabled ? 'Simulated WebSocket enabled.' : 'Simulated WebSocket disabled.';
      await loadDemoState();
      byId('rust-stream-test').click();
    } catch (error) {
      feedback.textContent = 'Demo mode could not be changed: ' + error.message;
    } finally {
      demoWorking = false;
      await loadDemoState().catch(() => {});
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
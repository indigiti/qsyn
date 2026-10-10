/* Phase 1.4: same-origin, session-owned mock account dashboard.
 * Browser never receives broker tokens, real quotes or execution capability. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const auth = '/qsyn/api/v1/auth/';
  const accountApi = '/qsyn/api/v1/accounts/';
  let csrf = '';
  let principal = null;
  let model = { accounts: [], selection: { account_id: null, revision: 0 } };
  let busy = false;

  function status(message = '', error = false) {
    const box = $('page-message');
    box.textContent = message;
    box.classList.toggle('error', error);
  }
  function node(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.className = css;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function control(label, css, callback, disabled = false) {
    const button = node('button', 'button ' + css, label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', () => execute(callback));
    return button;
  }
  async function call(url, payload = undefined) {
    const options = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (payload !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.headers['X-CSRF-Token'] = csrf;
      options.body = JSON.stringify(payload);
    }
    let response, data;
    try {
      response = await fetch(url, options);
      data = await response.json();
    } catch {
      throw new Error('The private QSYN service could not be reached.');
    }
    if (!response.ok) {
      const e = new Error({
        unauthorized: 'Your login expired. Sign in again.',
        forbidden: 'Your role does not allow this change.',
        revision_conflict: 'Another change occurred. Account details have been refreshed.',
        account_disconnected: 'This mock account is disconnected.',
        account_not_found: 'Account not found for your test identity.',
        invalid_credentials: 'Test tenant, username or password is incorrect.',
        too_many_attempts: 'Too many login attempts. Try again later.',
        mock_accounts_not_enabled: 'Mock account management is not enabled.',
      }[data?.error] || 'QSYN rejected the request (' + String(data?.error || response.status) + ').');
      e.status = response.status;
      throw e;
    }
    return data;
  }
  function showLogin() {
    $('workspace').hidden = true;
    $('signout-button').hidden = true;
    $('session-label').textContent = '';
    $('sign-in').hidden = false;
    $('password-input').value = '';
    $('account-chart').hidden = true;
  }
  function showWorkspace() {
    $('sign-in').hidden = true;
    $('workspace').hidden = false;
    $('signout-button').hidden = false;
    $('session-label').textContent = principal.username + ' · ' + principal.tenant_id;
    const canWrite = ['member', 'tenant_admin'].includes(principal.role);
    $('account-write-panel').hidden = !canWrite;
    $('readonly-message').hidden = canWrite;
  }

  async function execute(task) {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (error) {
      status(error.message, true);
      if (error.status === 401) {
        principal = null;
        showLogin();
      } else if (error.status === 409 && principal) {
        await refresh(false).catch(() => {});
      }
    } finally {
      busy = false;
    }
  }

  function renameEditor(account, card, actions) {
    const form = node('form', 'rename-form');
    const input = node('input');
    input.name = 'display_label';
    input.type = 'text';
    input.maxLength = 60;
    input.required = true;
    input.value = account.display_label;
    input.setAttribute('aria-label', 'New label for ' + account.display_label);
    const save = node('button', 'button primary', 'Save');
    save.type = 'submit';
    const cancel = node('button', 'button ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => form.remove());
    form.append(input, save, cancel);
    form.addEventListener('submit', event => {
      event.preventDefault();
      execute(async () => {
        await call(accountApi + 'rename', {
          account_id: account.account_id,
          expected_revision: account.revision,
          display_label: input.value.trim(),
        });
        form.remove();
        await refresh();
        status('Mock account label updated.');
      });
    });
    actions.after(form);
    input.focus();
  }

  function renderAccounts() {
    const list = $('account-list');
    list.replaceChildren();
    $('account-count').textContent = String(model.accounts.length);
    $('empty-accounts').hidden = model.accounts.length !== 0;
    const selectedId = model.selection.account_id;
    const canWrite = ['member', 'tenant_admin'].includes(principal.role);

    for (const account of model.accounts) {
      const selected = selectedId === account.account_id;
      const connected = account.auth_status === 'mock_connected';
      const card = node('li', 'account-item' + (selected ? ' selected' : ''));
      card.dataset.accountId = account.account_id;
      const header = node('div', 'account-name-row');
      const identity = node('div');
      identity.append(node('div', 'account-name', account.display_label));
      identity.append(node('div', 'account-meta',
        account.broker_code.toUpperCase() + ' · ' + (connected ? 'Simulated connected' : 'Disconnected')));
      header.append(identity);
      header.append(node('span', 'pill' + (selected ? ' active' : ''), selected ? 'CHART SOURCE' : (connected ? 'MOCK' : 'OFF')));
      card.append(header);
      if (canWrite && connected) {
        const actions = node('div', 'card-actions');
        if (!selected) actions.append(control('Select chart', 'primary', async () => {
          await call(accountApi + 'select', {
            account_id: account.account_id,
            expected_revision: model.selection.revision,
          });
          window.location.reload();
        }));
        actions.append(control('Rename', 'ghost', async () => renameEditor(account, card, actions)));
        actions.append(control('Disconnect', 'danger', async () => {
          if (!window.confirm('Disconnect this simulated account?')) return;
          await call(accountApi + 'disconnect', {
            account_id: account.account_id, expected_revision: account.revision,
          });
          if (selected) {
            window.location.reload();
            return;
          }
          await refresh();
          status('Mock account disconnected.');
        }));
        card.append(actions);
      }
      list.append(card);
    }
  }

  async function renderChart() {
    const account = model.accounts.find(x =>
      x.account_id === model.selection.account_id && x.auth_status === 'mock_connected');
    $('chart-source-label').textContent = account
      ? account.display_label + ' / ' + account.broker_code.toUpperCase() +
        ' · session-owned synthetic data'
      : 'No mock chart source selected';
    $('chart-empty').hidden = Boolean(account);
    $('account-chart').hidden = !account;
    if (!account) return;
    if (!window.QsynAccountChart?.mount) {
      status('The account-scoped chart bundle is unavailable.', true);
      return;
    }
    try {
      await window.QsynAccountChart.mount($('account-chart'), account.account_id);
    } catch {
      $('account-chart').hidden = true;
      $('chart-empty').hidden = false;
      status('Account-scoped simulated chart could not load.', true);
    }
  }

  async function refresh(drawChart = true) {
    model = await call(accountApi + 'list');
    if (model.mode !== 'simulated' || !Array.isArray(model.accounts)) {
      throw new Error('Invalid account source provenance');
    }
    renderAccounts();
    if (drawChart) await renderChart();
  }

  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    execute(async () => {
      const data = await call(auth + 'login', {
        tenant: $('tenant-input').value.trim(),
        username: $('user-input').value.trim(),
        password: $('password-input').value,
      });
      if (!data.authenticated || !data.user || !data.csrf) throw new Error('Login response invalid');
      principal = data.user;
      csrf = data.csrf;
      showWorkspace();
      status('');
      await refresh();
    });
  });
  $('signout-button').addEventListener('click', () => execute(async () => {
    const result = await call(auth + 'logout', {});
    principal = null;
    csrf = result.csrf || '';
    showLogin();
    status('Signed out of the mock workspace.');
  }));
  $('refresh-button').addEventListener('click', () => execute(async () => {
    await refresh();
    status('Account list refreshed.');
  }));
  $('add-form').addEventListener('submit', event => {
    event.preventDefault();
    execute(async () => {
      await call(accountApi + 'link', {
        broker_code: $('broker-input').value,
        mock_reference: $('reference-input').value.trim(),
        display_label: $('label-input').value.trim(),
      });
      $('add-form').reset();
      await refresh();
      status('Mock account added. Select it to view simulated candles.');
    });
  });
  async function init() {
    try {
      const state = await call(auth + 'state');
      if (state.profile !== 'mock-only' || !state.csrf) throw new Error('Mock identity configuration is invalid.');
      csrf = state.csrf;
      principal = state.authenticated ? state.user : null;
      if (principal) {
        showWorkspace();
        status('');
        await refresh();
      } else {
        showLogin();
        status('');
      }
    } catch (error) {
      $('sign-in').hidden = true;
      $('workspace').hidden = true;
      status(error.message, true);
    }
  }
  init();
})();

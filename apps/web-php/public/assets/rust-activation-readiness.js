'use strict';

/**
 * Safe, read-only browser checklist for QSYN Rust activation.
 * No secret values, private file paths, shell execution or write operations.
 * No arbitrary diagnostic URLs; every request stays on same-origin QSYN API.
 */
(() => {
  const root = document.getElementById('activation-checks');
  const feedback = document.getElementById('activation-summary');
  const refresh = document.getElementById('activation-refresh');
  const copy = document.getElementById('activation-copy');
  if (!root || !feedback || !refresh || !copy) return;

  const endpoints = Object.freeze({
    admin: '/qsyn/api/v1/admin/rust/state',
    rust: '/qsyn/api/v1/diagnostics/rust',
    demo: '/qsyn/api/v1/admin/rust/demo',
  });

  async function read(endpoint) {
    const response = await fetch(endpoint, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('api_unavailable');
    return response.json();
  }

  function line(label, good, note) {
    const item = document.createElement('div');
    item.className = 'activation-item';
    const state = document.createElement('strong');
    state.textContent = good ? '✓ Ready' : '• Needs setup';
    state.className = good ? 'activation-ok' : 'activation-pending';
    const title = document.createElement('span');
    title.textContent = label;
    const details = document.createElement('small');
    details.textContent = note;
    item.append(state, title, details);
    return item;
  }

  async function update() {
    refresh.disabled = true;
    feedback.textContent = 'Checking approved QSYN endpoints…';
    root.replaceChildren();
    try {
      // Both endpoints are read-only. Never call login, action or POST.
      const [admin, rust] = await Promise.all([
        read(endpoints.admin),
        read(endpoints.rust),
      ]);
      const configured = admin.configured === true;
      const online = rust.status === 'online' && rust.http === 'healthy';
      const supported = online && rust.demo_runtime_control === true;
      const streaming = supported && rust.demo_ws_enabled === true;
      root.append(
        line('Administrator sign-in', configured,
          configured ? 'Secure admin credentials are configured.'
            : 'First-time setup: read the one-time code in private_html/qsyn/runtime/admin-setup-code.txt via Cloudways private SFTP, then create your password on this page. Never share the code.'),
        line('Rust HTTP engine', online,
          online ? 'Private Rust /health reachable through PHP.'
            : 'Cloudways must verify the QSYN-only process on 127.0.0.1:10251.'),
        line('No-restart demo toggle', supported,
          supported ? 'Running Rust executable supports private-file runtime switching.'
            : 'Existing Rust process needs a one-time verified upgrade/restart; deploying a new ELF alone does not replace a running process.'),
      );

      let writable = null;
      let authenticated = admin.authenticated === true;
      if (authenticated) {
        try {
          const demo = await read(endpoints.demo);
          writable = demo.writable === true;
          root.append(line('Private demo setting', writable,
            writable ? 'PHP can write the QSYN-only private runtime flag.'
              : 'Cloudways must give the QSYN PHP identity write access to private_html/qsyn/runtime, without public permissions.'));
        } catch (_error) {
          root.append(line('Private demo setting', false, 'Admin-only runtime test unavailable; check QSYN server configuration.'));
        }
      }
      root.append(line('Simulated WebSocket', streaming,
        streaming ? 'Ready to click Connect Rust demo on the chart.'
          : 'After secure sign-in, click Enable demo stream in the administration panel.'));

      const allReady = configured && online && supported && streaming &&
        (writable === null || writable === true);
      feedback.textContent = allReady
        ? 'Rust demo is enabled. Return to QSYN chart and click Connect Rust demo.'
        : 'Rust demo activation is incomplete. This is a read-only checklist; no process or credentials were changed.';
      copy.dataset.report = [
        'QSYN / Cloudways activation request (staging only)',
        'Please keep QNEXT untouched and never expose port 10251 publicly.',
        '1. First visit to /qsyn/admin/rust: the application generates an owner-only 256-bit code in private_html/qsyn/runtime/admin-setup-code.txt. Retrieve it with authorized Cloudways private SFTP/file manager, then enter it in Create administrator password. The code is never returned over HTTP; no public first-user claim is allowed.',
        '2. Server operator only if needed: verify that qsyn-stream /health at 127.0.0.1:10251 reports demo_runtime_control=true. If it does not, perform a controlled QSYN-only executable transition, leaving QNEXT untouched.',
        '3. Server permissions only if needed: ensure QSYN PHP can read the private 0600 administrator configuration and atomically write the demo flag under private_html/qsyn/runtime. Rust must be able to read that flag. No broad process-execution privileges.',
        '4. Preserve restrictive application permissions, HTTPS and QSYN admin session/CSRF protections.',
        '5. After provisioning, confirm the QSYN admin can enable simulated streaming and the chart can connect. No Upstox orders or real feeds.',
        '',
        'Read-only browser observations:',
        'admin_configured=' + configured,
        'rust_http_online=' + online,
        'rust_runtime_demo_toggle=' + supported,
        'rust_demo_enabled=' + streaming,
        'private_flag_writable=' + (writable === null ? 'not_tested_before_login' : String(writable)),
      ].join('\n');
      copy.disabled = false;
    } catch (_error) {
      feedback.textContent = 'Activation readiness could not be checked from this browser.';
      root.append(line('QSYN diagnostics API', false,
        'The read-only status endpoint is unavailable. The service was not changed.'));
      copy.disabled = true;
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', update);
  copy.addEventListener('click', async () => {
    if (!copy.dataset.report) return;
    try {
      await navigator.clipboard.writeText(copy.dataset.report);
      copy.textContent = 'Request copied';
    } catch (_error) {
      feedback.textContent = 'Browser clipboard unavailable. Cloudways can follow the setup steps displayed above.';
    }
  });
  update();
})();

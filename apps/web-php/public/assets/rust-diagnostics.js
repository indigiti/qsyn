'use strict';

const trigger = document.getElementById('rust-test');
const result = document.getElementById('rust-result');
const details = document.getElementById('rust-details');

if (trigger && result && details) {
  trigger.addEventListener('click', async () => {
    trigger.disabled = true;
    result.textContent = 'Checking…';
    details.textContent = 'Testing the Cloudways server-side connection to the Rust service.';

    try {
      const response = await fetch('/qsyn/api/v1/diagnostics/rust', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Diagnostics API unavailable');
      const data = await response.json();
      if (data.status === 'online' && data.http === 'healthy') {
        result.textContent = 'Rust online';
        result.style.color = '#65d6a7';
        const websocket = data.websocket === 'demo_enabled'
          ? 'WebSocket handshake passed'
          : data.websocket === 'demo_disabled'
            ? 'Demo WebSocket is disabled (expected unless explicitly enabled)'
            : 'WebSocket probe unavailable';
        details.textContent =
          `HTTP OK (${data.latency_ms} ms) · ${websocket} · Live Upstox: ${data.upstox_connected ? 'yes' : 'no'}`;
      } else if (data.status === 'offline') {
        result.textContent = 'Rust offline';
        result.style.color = '#ffbc75';
        details.textContent =
          'PHP is responding, but the Rust service is not reachable on localhost. A deployed binary is not the same as a running daemon.';
      } else {
        result.textContent = 'Check failed';
        result.style.color = '#ffbc75';
        details.textContent = 'Rust returned an unexpected response. Review the deployed service and runtime configuration.';
      }
    } catch (error) {
      result.textContent = 'Diagnostics unavailable';
      result.style.color = '#ffbc75';
      details.textContent = 'The browser could not read the QSYN diagnostics API.';
    } finally {
      trigger.disabled = false;
    }
  });
}

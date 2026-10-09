'use strict';

// PHP-to-Rust WebSocket sampling: no public socket or browser access to localhost.
const streamButton = document.getElementById('rust-stream-test');
const streamResult = document.getElementById('rust-stream-result');
const streamSamples = document.getElementById('rust-stream-samples');

if (streamButton && streamResult && streamSamples) {
  streamButton.addEventListener('click', async () => {
    streamButton.disabled = true;
    streamResult.textContent = 'Sampling…';
    streamSamples.textContent = 'Connecting through QSYN PHP to the private Rust demo stream.';
    try {
      const response = await fetch('/qsyn/api/v1/diagnostics/rust-stream', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('stream_api_unavailable');
      const data = await response.json();
      if (data.status === 'streaming' && Array.isArray(data.quotes) && data.quotes.length === 2) {
        streamResult.textContent = '2 demo quotes received';
        streamResult.style.color = '#65d6a7';
        const quotes = data.quotes.map(item => {
          const price = Number(item.price);
          return Number.isFinite(price) && item.symbol === 'QSYN-DEMO'
            ? '₹' + price.toFixed(2) : 'invalid quote';
        });
        streamSamples.textContent = 'QSYN-DEMO (simulated) · ' + quotes.join(' → ') + ' · ' + data.latency_ms + ' ms';
      } else if (data.status === 'demo_disabled') {
        streamResult.textContent = 'Demo stream disabled';
        streamResult.style.color = '#ffbc75';
        streamSamples.textContent = 'Rust HTTP is online. Restart Rust with QSYN_ENABLE_DEMO_WS=1 to enable simulated WebSocket quotes.';
      } else if (data.status === 'offline') {
        streamResult.textContent = 'Rust offline';
        streamResult.style.color = '#ffbc75';
        streamSamples.textContent = 'The private Rust service is not listening at 127.0.0.1:10251.';
      } else {
        streamResult.textContent = 'Stream test failed';
        streamResult.style.color = '#ffbc75';
        streamSamples.textContent = 'WebSocket sample did not complete (' + String(data.status || 'unknown') + ').';
      }
    } catch (_error) {
      streamResult.textContent = 'Test unavailable';
      streamResult.style.color = '#ffbc75';
      streamSamples.textContent = 'The QSYN WebSocket test API could not be reached.';
    } finally {
      streamButton.disabled = false;
    }
  });
}

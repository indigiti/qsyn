import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';
import { QsynDemoFeed } from './rust-demo-feed.js';

const root = document.getElementById('terminal');
if (root) {
  root.replaceChildren();
  const connectButton = document.getElementById('chart-live-connect');
  const liveStatus = document.getElementById('chart-live-status');
  const updateStatus = message => {
    if (liveStatus) liveStatus.textContent = message;
    if (connectButton) {
      connectButton.textContent = feed.enabled ? 'Disconnect Rust demo' : 'Connect Rust demo';
      connectButton.setAttribute('aria-pressed', String(feed.enabled));
    }
  };
  const feed = new QsynDemoFeed(updateStatus);
  const widget = createWidget(root, {
    feed,
    symbol: 'QSYN-DEMO',
    exchange: 'QSYN',
    interval: '1m',
    theme: 'dark',
    // One-time namespace bump avoids stale Phase-0 viewport/scale state.
    persist: 'qsyn-dev-demo-v2',
    navigation: { defaultVisibleBars: 100, mousePan: 'horizontal' },
  });
  if (connectButton) {
    connectButton.addEventListener('click', () => {
      // Explicit opt-in: no background polling, credentials or broker feeds
      // until the user chooses to connect a simulated source.
      feed.setEnabled(!feed.enabled);
    });
  }

  const fitButton = document.getElementById('chart-reset');
  const fitStatus = document.getElementById('chart-reset-status');

  if (fitButton) {
    fitButton.addEventListener('click', async () => {
      fitButton.disabled = true;
      if (fitStatus) fitStatus.textContent = 'Refitting candles…';
      try {
        await widget.ready;
        // Unlike setData(), fitContent deliberately overrides a panned or
        // zoomed viewport and restores the full loaded candle range.
        widget.chart.fitContent();
        if (fitStatus) fitStatus.textContent = 'All loaded candles fitted.';
      } catch (error) {
        console.error('QSYN chart viewport reset failed', error);
        if (fitStatus) fitStatus.textContent = 'Reset failed; please reload the page.';
      } finally {
        fitButton.disabled = false;
      }
    });
  }

  widget.ready.catch((error) => {
    console.error('Chart initialization failed', error);
    root.textContent = 'Chart initialization failed. Check the browser console.';
    if (fitStatus) fitStatus.textContent = 'Chart initialization failed.';
  });
}

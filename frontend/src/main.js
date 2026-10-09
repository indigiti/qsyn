import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';

/** Phase-0 feed uses only the QSYN PHP demo endpoint. No broker key in browser. */
class QsynDemoFeed {
  async getBars({ symbol }) {
    if (symbol !== 'QSYN-DEMO') return [];
    const r = await fetch('/qsyn/api/v1/demo/bars', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('QSYN demo bars unavailable');
    const response = await r.json();
    if (response.mode !== 'simulated') throw new Error('Unexpected data provenance');
    return response.bars;
  }
}

const root = document.getElementById('terminal');
if (root) {
  root.replaceChildren();
  const widget = createWidget(root, {
    feed: new QsynDemoFeed(),
    symbol: 'QSYN-DEMO',
    exchange: 'QSYN',
    interval: '1m',
    theme: 'dark',
    // One-time namespace bump avoids stale Phase-0 viewport/scale state.
    persist: 'qsyn-dev-demo-v2',
    navigation: { defaultVisibleBars: 100, mousePan: 'horizontal' },
  });
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

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
    persist: 'qsyn-dev-demo',
  });
  widget.ready.catch((error) => {
    console.error('Chart initialization failed', error);
    root.textContent = 'Chart initialization failed. Check the browser console.';
  });
}

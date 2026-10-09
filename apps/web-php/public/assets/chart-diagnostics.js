'use strict';

// Local browser diagnostics for the Phase-0 chart. No requests, secrets,
// instrumentation uploads, process controls or inline JavaScript.
// This file is loaded first to observe CSP violations as the page boots.
(() => {
  const violations = [];
  document.addEventListener('securitypolicyviolation', event => {
    if (violations.length < 20) {
      violations.push({
        directive: String(event.violatedDirective || '').slice(0, 90),
        blocked: event.blockedURI === 'inline' ? 'inline' : 'other',
      });
    }
  });

  function pixelStats(canvas) {
    if (!canvas.width || !canvas.height) return { width: canvas.width, height: canvas.height, red: 0, green: 0 };
    let red = 0, green = 0;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 96) continue;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          if (r > 92 && r > g * 1.24 && r > b * 1.10) red++;
          if (g > 60 && g > r * 1.18 && g > b * 0.92) green++;
        }
      }
    } catch (_error) {
      return { width: canvas.width, height: canvas.height, pixelReadback: 'unavailable' };
    }
    return { width: canvas.width, height: canvas.height, red, green };
  }

  function inspect() {
    const canvases = Array.from(document.querySelectorAll('#terminal canvas'));
    const measurements = canvases.map(pixelStats);
    const red = measurements.reduce((n, item) => n + (item.red || 0), 0);
    const green = measurements.reduce((n, item) => n + (item.green || 0), 0);
    const asset = document.querySelector('script[src*="/qsyn/assets/chart.js"]');
    const assetUrl = asset ? new URL(asset.src, location.origin) : null;
    const resource = performance.getEntriesByType('resource').find(entry =>
      assetUrl && entry.name === assetUrl.href);
    const chartContainer = document.getElementById('terminal');
    const bounds = chartContainer ? chartContainer.getBoundingClientRect() : null;
    const layout = {
      width: bounds ? Math.round(bounds.width) : 0,
      height: bounds ? Math.round(bounds.height) : 0,
      hidden: chartContainer ? getComputedStyle(chartContainer).display === 'none' : true,
    };
    let conclusion = 'Chart canvases contain candlestick colors.';
    if (!canvases.length || layout.width < 100 || layout.height < 100) {
      conclusion = 'Chart canvas/layout missing or too small.';
    } else if (green < 25 || red < 25) {
      conclusion = 'Candle pixels missing from canvas in this browser.';
    }

    return {
      component: 'qsyn-chart-browser',
      page: 'qsyn',
      clientTime: new Date().toISOString(),
      chartBundleVersion: assetUrl?.searchParams.get('v') || 'unversioned',
      browserDeviceScaleFactor: devicePixelRatio,
      layout,
      canvases: measurements,
      coloredPixels: { red, green },
      bundleLoaded: Boolean(resource),
      bundleNetworkTransferBytes: resource?.transferSize ?? null,
      cspViolationsObserved: violations,
      conclusion,
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    const run = document.getElementById('chart-diagnose');
    const output = document.getElementById('chart-diagnostic-report');
    const copy = document.getElementById('chart-diagnostic-copy');
    if (!run || !output || !copy) return;
    run.addEventListener('click', () => {
      const report = JSON.stringify(inspect(), null, 2);
      output.textContent = report;
      copy.disabled = false;
      copy.dataset.report = report;
    });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copy.dataset.report || output.textContent || '');
        copy.textContent = 'Copied';
      } catch (_error) {
        copy.textContent = 'Select and copy report below';
      }
    });
  });
})();

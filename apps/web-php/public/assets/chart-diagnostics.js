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
    const bounds = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const parent = canvas.parentElement;
    const parentStyle = parent ? getComputedStyle(parent) : null;
    const stats = {
      width: canvas.width,
      height: canvas.height,
      css: {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        zIndex: style.zIndex,
        transform: style.transform,
        mixBlendMode: style.mixBlendMode,
        parentOverflow: parentStyle?.overflow || 'unknown',
        parentOpacity: parentStyle?.opacity || 'unknown',
      },
      red: 0,
      green: 0,
      nonTransparentPixels: 0,
      mostlyOpaquePixels: 0,
      alphaCoveragePercent: 0,
      opaqueCoveragePercent: 0,
    };
    if (!canvas.width || !canvas.height) return stats;
    try {
      // The chart originally creates its 2D context. Re-reading it with this
      // flag does not change its creation settings (Chromium can warn).
      const context = canvas.getContext('2d');
      if (context) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const total = canvas.width * canvas.height;
        for (let i = 0; i < pixels.length; i += 4) {
          const a = pixels[i + 3];
          if (a > 0) stats.nonTransparentPixels++;
          if (a >= 245) stats.mostlyOpaquePixels++;
          if (a < 96) continue;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          if (r > 92 && r > g * 1.24 && r > b * 1.10) stats.red++;
          if (g > 60 && g > r * 1.18 && g > b * 0.92) stats.green++;
        }
        stats.alphaCoveragePercent = Math.round(1000 * stats.nonTransparentPixels / total) / 10;
        stats.opaqueCoveragePercent = Math.round(1000 * stats.mostlyOpaquePixels / total) / 10;
      }
    } catch (_error) {
      stats.pixelReadback = 'unavailable';
    }
    return stats;
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
    } else if (measurements.length >= 2
        && measurements[0].red + measurements[0].green > 50
        && measurements[1].opaqueCoveragePercent > 90) {
      conclusion = 'The transparent upper layer looks opaque and may cover the painted candle layer.';
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
    const preview = document.getElementById('chart-canvas-preview');
    const image = document.getElementById('chart-canvas-preview-image');
    const showPreview = document.getElementById('chart-preview-button');
    if (!run || !output || !copy || !preview || !image || !showPreview) return;
    run.addEventListener('click', () => {
      const report = JSON.stringify(inspect(), null, 2);
      output.textContent = report;
      copy.disabled = false;
      copy.dataset.report = report;
    });
    showPreview.addEventListener('click', () => {
      const base = document.querySelector('#terminal canvas');
      if (!base || !base.width || !base.height) {
        output.textContent = 'The chart canvas is unavailable. Run Diagnose chart.';
        return;
      }
      try {
        // The browser decodes a real image of the candlestick canvas.
        // This distinguishes painted pixels from DOM layer composition.
        // It stays on this device and is never uploaded.
        image.src = base.toDataURL('image/png');
        preview.hidden = false;
        showPreview.textContent = 'Refresh image preview';
      } catch (_error) {
        output.textContent = 'Canvas image preview is unavailable.';
      }
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

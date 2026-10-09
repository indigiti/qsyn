// Browser regression for real candlestick painting, not only OHLC footer data.
// Run after npm run build with Chromium installed: node tests/browser-chart-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdir, copyFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const project = resolve(import.meta.dirname, '../..');
const chartAsset = resolve(project, 'apps/web-php/public/assets/chart.js');
const bundle = resolve(project, 'frontend/dist/chart.js');
const screenshots = resolve(project, 'frontend/artifacts');
const errors = [];
const warnings = [];
let server;
let browser;

async function freePort() {
  return new Promise((done, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => done(port));
    });
  });
}

async function waitForHealth(origin) {
  for (let i = 0; i < 55; ++i) {
    try {
      if ((await fetch(origin + '/qsyn/api/v1/health')).ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error('local PHP application never became healthy');
}

async function paintedPixels(page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('#terminal canvas')];
    const entries = [];
    let green = 0, red = 0;
    for (const canvas of canvases) {
      let g = 0, r = 0;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx && canvas.width && canvas.height) {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 96) continue;
          const [rr, gg, bb] = [data[i], data[i + 1], data[i + 2]];
          if (gg > 60 && gg > rr * 1.18 && gg > bb * 0.92) g++;
          if (rr > 92 && rr > gg * 1.24 && rr > bb * 1.10) r++;
        }
      }
      entries.push({ width: canvas.width, height: canvas.height,
        green: g, red: r, parentClass: String(canvas.parentElement?.className || '').slice(0, 100) });
      green += g;
      red += r;
    }
    return { canvasCount: canvases.length, green, red, entries,
      footer: document.body.innerText.slice(-400) };
  });
}

try {
  await mkdir(screenshots, { recursive: true });
  await copyFile(bundle, chartAsset);
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  server = spawn('php', ['-S', '127.0.0.1:' + port, '-t',
    'apps/web-php/public', 'apps/web-php/dev-router.php'],
    { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let phpError = '';
  server.stderr.on('data', data => { phpError += String(data).slice(-1500); });
  await waitForHealth(origin);
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', err => errors.push(err.stack || err.message));
  page.on('console', item => {
    if (item.type() === 'error') warnings.push(item.text().slice(0, 450));
  });
  await page.addInitScript(() => {
    window.__qsynCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__qsynCspViolations.push({ blockedURI: event.blockedURI,
        directive: event.violatedDirective, sample: event.sample });
    });
  });
  await page.goto(origin + '/qsyn/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes('120 bars'),
    null, { timeout: 12000 });
  await page.waitForTimeout(1200);
  const initial = await paintedPixels(page);
  await page.screenshot({ path: resolve(screenshots, 'chart-initial.png'), fullPage: true });
  await page.locator('#chart-reset').click();
  await page.waitForTimeout(800);
  const after = await paintedPixels(page);
  await page.screenshot({ path: resolve(screenshots, 'chart-reset.png'), fullPage: true });
  const violations = await page.evaluate(() => window.__qsynCspViolations);
  const bars = await (await page.request.get(origin + '/qsyn/api/v1/demo/bars')).json();
  console.log('CHART_BROWSER_DIAGNOSTICS ' + JSON.stringify({
    bars: bars.bars?.length, first: bars.bars?.[0], last: bars.bars?.at(-1),
    initial, after, violations, pageErrors: errors, consoleErrors: warnings,
    phpError: phpError.slice(-600),
  }));
  if (bars.bars?.length !== 120) throw Error('PHP failed to serve 120 demo bars');
  if (!initial.canvasCount) throw Error('Chart did not create a canvas');
  if (errors.length) throw Error('Uncaught chart JavaScript error');
  if (after.green < 25 || after.red < 25) {
    throw Error('CHART_BLANK: bar count and footer loaded but colored candlesticks did not paint');
  }
  console.log('PASS: browser paints red and green candlestick pixels under strict CSP');
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  await unlink(chartAsset).catch(() => {});
}

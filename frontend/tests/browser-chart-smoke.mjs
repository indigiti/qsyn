// Browser regression for real candlestick painting, not only OHLC footer data.
// Run after npm run build with Chromium installed: node tests/browser-chart-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, rm, copyFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
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
let temporaryRuntime;

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
  temporaryRuntime = await mkdtemp(join(tmpdir(), 'qsyn-browser-first-run-'));
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  server = spawn('php', ['-S', '127.0.0.1:' + port, '-t',
    'apps/web-php/public', 'apps/web-php/dev-router.php'],
    { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      QSYN_RUNTIME_DIR: temporaryRuntime,
      QSYN_ALLOW_HTTP_TEST: '1',
    } });
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
  // DigiOps previously versioned only chart.js; its stale unversioned
  // Rust stream client kept telling users to restart the daemon from SSH.
  // Every executable JS asset on both chart and admin pages must be versioned.
  for (const name of ['rust-diagnostics.js', 'rust-stream-test.js']) {
    const src = await page.locator('script[src*="/qsyn/assets/' + name + '"]').getAttribute('src');
    if (!src || !src.includes('?v=') || src.endsWith('?v=0')) {
      throw new Error('Chart loaded unversioned or missing Rust browser asset: ' + name + ' / ' + src);
    }
  }
  const adminResponse = await page.request.get(origin + '/qsyn/admin/rust');
  if (adminResponse.status() !== 200
      || !String(adminResponse.headers()['cache-control'] || '').includes('no-store')) {
    throw new Error('Admin HTML should be uncacheable');
  }
  const adminHtml = await adminResponse.text();
  for (const name of ['rust-admin.js', 'rust-stream-test.js', 'rust-activation-readiness.js']) {
    if (!adminHtml.includes('/qsyn/assets/' + name + '?v=')) {
      throw new Error('Admin page contains unversioned browser script: ' + name);
    }
  }
  // Read-only admin readiness must work for visitors without authentication
  // and must never expose a password, enable the demo or execute a command.
  const adminBrowser = await browser.newPage();
  adminBrowser.on('pageerror', err => errors.push(err.stack || err.message));
  await adminBrowser.goto(origin + '/qsyn/admin/rust', { waitUntil: 'networkidle', timeout: 20000 });
  await adminBrowser.waitForFunction(() => {
    const text = document.getElementById('activation-summary')?.textContent || '';
    return text.includes('activation is incomplete') || text.includes('Rust demo is enabled');
  }, null, { timeout: 6000 });
  if (!(await adminBrowser.locator('#activation-checks .activation-item').count() >= 4)) {
    throw new Error('QSYN browser activation checklist did not report setup status');
  }
  if (!(await adminBrowser.locator('#activation-copy').isEnabled())) {
    throw new Error('Cloudways request copy option was not activated');
  }
  const activationInfo = await adminBrowser.locator('#activation-checks').innerText();
  if (!activationInfo.includes('Administrator sign-in')
      || !activationInfo.includes('Rust HTTP engine')
      || !activationInfo.includes('No-restart demo toggle')) {
    throw new Error('Activation checklist missed required security gates');
  }
  // First-run password creation is a web operation, but it can only be
  // claimed with a private 256-bit code retrieved by the trusted operator.
  if (!(await adminBrowser.locator('#admin-first-run').isVisible())) {
    throw new Error('First-run setup form not visible on unconfigured QSYN');
  }
  const secretFile = join(temporaryRuntime, 'admin-setup-code.txt');
  const code = (await readFile(secretFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(code) || (await stat(secretFile)).mode % 512 !== 0o600) {
    throw new Error('Private setup code missing or its file mode is unsafe');
  }
  const browserCookies = await adminBrowser.context().cookies(origin);
  if (!browserCookies.some(cookie => cookie.name === 'QSYN_ADMIN_SESSION')) {
    throw new Error('QSYN admin session cookie was not preserved in Chromium');
  }
  const unauthenticatedState = await adminBrowser.evaluate(async () => {
    const response = await fetch('/qsyn/api/v1/admin/rust/state', {
      credentials: 'same-origin', cache: 'no-store',
    });
    return response.text();
  });
  if (unauthenticatedState.includes(code)) {
    throw new Error('Secret pairing code leaked in public admin state');
  }
  if (!JSON.parse(unauthenticatedState).setup?.csrf) {
    throw new Error('First-run csrf token not available in same-origin session');
  }
  await adminBrowser.locator('#setup-code').fill(code);
  const freshPassword = 'strong-browser-only-setup-' + 'X'.repeat(24);
  await adminBrowser.locator('#setup-password').fill(freshPassword);
  await adminBrowser.locator('#setup-confirm').fill(freshPassword);
  const firstRunResponsePromise = adminBrowser.waitForResponse(response =>
    response.url().endsWith('/qsyn/api/v1/admin/rust/setup'), { timeout: 7000 });
  await adminBrowser.locator('#setup-button').click();
  const firstRunResponse = await firstRunResponsePromise;
  const firstRunStatus = firstRunResponse.status();
  const firstRunResponseBody = await firstRunResponse.json();
  if (firstRunStatus !== 200 || firstRunResponseBody.ok !== true) {
    throw new Error('First-run setup API rejected request: HTTP ' + firstRunStatus +
      ' / ' + String(firstRunResponseBody.error || 'unknown'));
  }
  await adminBrowser.waitForFunction(() => {
    const text = document.getElementById('feedback')?.textContent || '';
    return text.includes('Administrator password created.')
      || text.includes('First-time setup could not be completed.');
  }, null, { timeout: 7000 });
  const setupFeedback = await adminBrowser.locator('#feedback').textContent();
  if (!setupFeedback.includes('Administrator password created.')) {
    throw new Error('First-run browser setup failed: ' + setupFeedback);
  }
  await adminBrowser.locator('#admin-login').waitFor({ state: 'visible', timeout: 7000 });
  await adminBrowser.locator('#admin-first-run').waitFor({ state: 'hidden', timeout: 7000 });
  await adminBrowser.locator('#admin-password').fill(freshPassword);
  await adminBrowser.locator('#login-button').click();
  await adminBrowser.waitForFunction(() =>
    !document.getElementById('admin-panel')?.hidden, null, { timeout: 7000 });
  if (!(await adminBrowser.locator('#admin-panel').isVisible())) {
    throw new Error('New private administrator could not sign in');
  }
  await adminBrowser.close();
  const chartSrc = await page.locator('script[src*="/qsyn/assets/chart.js"]').getAttribute('src');
  if (!chartSrc || !/chart[.]js[?]v=[0-9]+/.test(chartSrc)) {
    throw new Error('DigiOps chart bundle URL missing deployment cache-busting version: ' + chartSrc);
  }
  await page.locator('details.chart-debug summary').click();
  await page.locator('#chart-diagnose').click();
  const browserReport = JSON.parse(await page.locator('#chart-diagnostic-report').textContent());
  if (browserReport.coloredPixels.green < 25 || browserReport.coloredPixels.red < 25) {
    throw new Error('In-page diagnostics did not detect painted candlesticks');
  }
  if (browserReport.chartBundleVersion === 'unversioned') {
    throw new Error('In-page diagnostics reported unversioned chart asset');
  }
  if (typeof browserReport.canvases[1]?.opaqueCoveragePercent !== 'number') {
    throw new Error('The chart overlay alpha was not measured');
  }
  if (browserReport.canvases[1].opaqueCoveragePercent > 90) {
    throw new Error('Top canvas unexpectedly opaque; would obscure the painted candlestick layer');
  }
  await page.locator('#chart-preview-button').click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#chart-canvas-preview-image');
    return img && img.complete && img.naturalWidth > 0;
  });
  if (await page.locator('#chart-canvas-preview').isHidden()) {
    throw new Error('Painted canvas image preview remained hidden');
  }
  await page.screenshot({ path: resolve(screenshots, 'chart-canvas-preview.png'), fullPage: true });

  // Reproduce the reported devicePixelRatio=1.25 Chrome environment too.
  const scaledPage = await browser.newPage({
    viewport: { width: 1600, height: 920 }, deviceScaleFactor: 1.25,
  });
  scaledPage.on('pageerror', err => errors.push(err.stack || err.message));
  await scaledPage.goto(origin + '/qsyn/', { waitUntil: 'networkidle', timeout: 20000 });
  await scaledPage.waitForFunction(() => document.body.innerText.includes('120 bars'),
    null, { timeout: 12000 });
  await scaledPage.waitForTimeout(400);
  await scaledPage.locator('details.chart-debug summary').click();
  await scaledPage.locator('#chart-diagnose').click();
  const scaledReport = JSON.parse(await scaledPage.locator('#chart-diagnostic-report').textContent());
  if (scaledReport.browserDeviceScaleFactor !== 1.25
      || scaledReport.coloredPixels.red < 25 || scaledReport.coloredPixels.green < 25) {
    throw new Error('Chrome 125% DPR paint regression: ' + JSON.stringify(scaledReport));
  }
  if (scaledReport.canvases[1]?.opaqueCoveragePercent > 90) {
    throw new Error('Opaque top canvas masks base layer at 125% DPR');
  }
  await scaledPage.screenshot({ path: resolve(screenshots, 'chart-125-percent.png'), fullPage: true });
  await scaledPage.close();

  // No real broker and no live Rust process: mock only the exact bounded
  // PHP sampler API, and exercise OpenAlgo Charts' subscribeBars integration.
  let simulatedCalls = 0;
  await page.route('**/qsyn/api/v1/diagnostics/rust-stream', async route => {
    simulatedCalls++;
    const timestamp = Math.floor(Date.now() / 1000);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'streaming',
        service: 'qsyn-stream',
        websocket: 'demo_enabled',
        received: 2,
        quotes: [
          { symbol: 'QSYN-DEMO', source: 'simulated', timestamp, price: 226.01 },
          { symbol: 'QSYN-DEMO', source: 'simulated', timestamp, price: 228.02 },
        ],
        latency_ms: 1.2,
      }),
    });
  });
  const liveButton = page.locator('#chart-live-connect');
  if (await liveButton.getAttribute('aria-pressed') !== 'false' || simulatedCalls !== 0) {
    throw new Error('Simulated live chart made requests before explicit opt-in');
  }
  await liveButton.click();
  await page.waitForFunction(() => {
    const status = document.getElementById('chart-live-status');
    return status && status.textContent.includes('Connected to Rust simulation');
  }, null, { timeout: 12000 });
  if (simulatedCalls < 1 || await liveButton.getAttribute('aria-pressed') !== 'true') {
    throw new Error('Opt-in live chart subscription did not activate');
  }
  const livePaint = await paintedPixels(page);
  if (livePaint.red < 25 || livePaint.green < 25) {
    throw new Error('Demo stream caused previously healthy candle chart to disappear');
  }
  await liveButton.click();
  if (await liveButton.getAttribute('aria-pressed') !== 'false') {
    throw new Error('Web live chart disconnect did not stop subscription');
  }
  const stoppedCalls = simulatedCalls;
  await page.waitForTimeout(300);
  if (simulatedCalls !== stoppedCalls) {
    throw new Error('Live chart continued polling after explicit disconnection');
  }
  await page.unrouteAll({ behavior: 'wait' });

  const violations = await page.evaluate(() => window.__qsynCspViolations);
  const bars = await (await page.request.get(origin + '/qsyn/api/v1/demo/bars')).json();
  console.log('CHART_BROWSER_DIAGNOSTICS ' + JSON.stringify({
    bars: bars.bars?.length, first: bars.bars?.[0], last: bars.bars?.at(-1),
    initial, after, livePaint, simulatedCalls, browserReport, scaledReport, violations, pageErrors: errors, consoleErrors: warnings,
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
  if (temporaryRuntime) await rm(temporaryRuntime, { recursive: true, force: true });
}

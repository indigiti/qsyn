// Integrated studio browser acceptance: fully simulated data; no live broker.
import { spawn } from 'node:child_process';
import { mkdir, copyFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const bundle = resolve(root, 'frontend/dist/studio.js');
const asset = resolve(root, 'apps/web-php/public/assets/studio.js');
const images = resolve(root, 'frontend/artifacts');
let php, browser;
const errors = [];
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolvePort(value));
    });
  });
}
try {
  await mkdir(images, { recursive: true });
  await copyFile(bundle, asset);
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  php = spawn('php', ['-S', '127.0.0.1:' + port, '-t',
    'apps/web-php/public', 'apps/web-php/dev-router.php'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      QSYN_IDENTITY_ENABLED: '0', QSYN_MOCK_ACCOUNTS_ENABLED: '0',
      QSYN_DASHBOARD_ENABLED: '0', QSYN_FIXTURE_BOOTSTRAP_ENABLED: '0',
    },
  });
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch(origin + '/qsyn/api/v1/health')).ok) break; } catch {}
    await delay(125);
  }
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1512, height: 1050 } });
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const response = await page.goto(origin + '/qsyn/studio', { waitUntil: 'networkidle' });
  if (response?.status() !== 200) throw new Error('Studio route is unavailable');
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized'),
    null, { timeout: 25000 });
  if (await page.locator('#chain tr').count() !== 13) throw new Error('Fictional chain grid missing');
  if (await page.locator('#legs .leg-row').count() !== 2) throw new Error('Default straddle missing');
  if (!await page.locator('#basket-title').innerText().then(s => s.includes('NIFTY'))) {
    throw new Error('Simulated NIFTY basket title missing');
  }
  const canvases = await page.locator('.chart canvas').count();
  if (canvases < 3) throw new Error('OpenAlgo Charts did not mount real canvas renderers');
  if (await page.locator('#entry').innerText() === '—') throw new Error('Payoff/cashflow not calculated');

  // Reference-inspired chart-first terminal: one functional, dominant chart,
  // native QSYN identity, toolbar controls and accessible offcanvas strategy.
  if (await page.locator('#strategy-drawer').isVisible()) {
    throw new Error('Chart-first terminal must keep the builder collapsed by default');
  }
  const chartRect = await page.locator('#basket-chart').boundingBox();
  if (!chartRect || chartRect.width < 1100 || chartRect.height < 420) {
    throw new Error('Primary chart no longer dominates a 1512px-wide terminal');
  }
  if ((await page.locator('#toolbar-underlying').inputValue()) !== 'NIFTY'
      || (await page.locator('#toolbar-interval').inputValue()) !== '1m') {
    throw new Error('Chart toolbar is not synchronized with strategy controls');
  }
  if ((await page.locator('.environment').innerText()).includes('LIVE')) {
    throw new Error('Simulator mislabeled as live on QSYN terminal');
  }
  await page.screenshot({ path: resolve(images, 'studio-chart-first-light.png'), fullPage: true });
  await page.locator('#toolbar-builder').click();
  if (!(await page.locator('#strategy-drawer').isVisible())) {
    throw new Error('Strategy builder drawer failed to open');
  }
  if ((await page.locator('#toolbar-builder').getAttribute('aria-expanded')) !== 'true') {
    throw new Error('Strategy builder accessibility state was not updated');
  }
  await page.keyboard.press('Escape');
  if (await page.locator('#strategy-drawer').isVisible()) {
    throw new Error('Escape failed to close options builder');
  }
  await page.locator('#toolbar-theme').click();
  await page.waitForFunction(() =>
    document.documentElement.dataset.theme === 'dark'
    && document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized'),
    null, { timeout: 25000 });
  await page.screenshot({ path: resolve(images, 'studio-chart-first-dark.png'), fullPage: true });
  await page.locator('#toolbar-theme').click();
  await page.waitForFunction(() =>
    document.documentElement.dataset.theme === 'light'
    && document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized'),
    null, { timeout: 25000 });

  await page.screenshot({ path: resolve(images, 'studio-straddle.png'), fullPage: true });

  // Four independent leg charts, not only two, and exact model gamma precision.
  await page.locator('#toolbar-builder').click();
  await page.locator('#add-leg').click();
  await page.locator('#add-leg').click();
  if (await page.locator('#legs .leg-row').count() !== 4) {
    throw new Error('Four-leg strategy editor stopped at two');
  }
  await page.locator('#render').click();
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized') &&
    !document.querySelector('#leg-panel-3')?.hidden &&
    document.querySelector('#leg-chart-3 canvas'),
    null, { timeout: 25000 });
  if (await page.locator('#leg-panel-2').isHidden() || await page.locator('#leg-panel-3').isHidden()) {
    throw new Error('Four-leg option charts are hidden');
  }
  if (!/^[+-]?[0-9,.]+\.[0-9]{6}$/.test(await page.locator('#greek-gamma').innerText())) {
    throw new Error('Gamma does not display the required 6 decimal places');
  }
  await page.screenshot({ path: resolve(images, 'studio-four-leg-chart.png'), fullPage: true });
  await page.locator('#toolbar-builder').click();
  await page.locator('#straddle').click();
  await page.locator('#render').click();
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized') &&
    document.querySelector('#leg-panel-3')?.hidden,
    null, { timeout: 25000 });


  // Combined release acceptance: fixed-model analytics, replay, paper journal,
  // and foreground alerts must all work without enabling broker services.
  if (!(await page.locator('#risk-breakeven').innerText()).includes('/')) {
    throw new Error('Scenario breakevens missing from integrated risk report');
  }
  if (await page.locator('#greek-gamma').innerText() === '—') {
    throw new Error('Educational option Greeks were not rendered');
  }
  if (!(await page.locator('#risk-warning').innerText()).includes('fixed 20% volatility')) {
    throw new Error('Simulated-model assumptions not disclosed');
  }
  await page.locator('#paper-open').click();
  if ((await page.locator('#paper-open-count').innerText()) !== '1') {
    throw new Error('Simulated paper position was not recorded');
  }
  if (!(await page.evaluate(() => localStorage.getItem('qsyn-paper-ledger-v1') || '')).includes('simulated-browser-only')) {
    throw new Error('Paper journal omitted explicit simulation provenance');
  }
  await page.locator('#paper-positions').getByRole('button', { name: 'Close paper position' }).click();
  if ((await page.locator('#paper-open-count').innerText()) !== '0') {
    throw new Error('Paper close failed');
  }
  await page.locator('#alert-threshold').fill('100000');
  await page.locator('#alert-add').click();
  if (await page.locator('#alert-records .lab-alert').count() !== 1) {
    throw new Error('Browser-only option alert missing');
  }
  await page.evaluate(() => {
    const range = document.getElementById('replay-position');
    range.value = '60';
    range.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#replay-marker')?.textContent?.includes('61 / 120'));
  if (await page.locator('#paper-open').isDisabled()) {
    // Paper open is intentionally blocked in replay through a validation error,
    // not disabled, to preserve an explicit denial message.
    throw new Error('Replay paper guard button unexpectedly disabled');
  }
  await page.locator('#paper-open').click();
  if (!(await page.locator('#status').innerText()).includes('Return replay to latest')) {
    throw new Error('Replay position incorrectly permitted paper entry');
  }
  await page.locator('#replay-end').click();
  await page.waitForFunction(() => document.querySelector('#replay-marker')?.textContent?.includes('120 / 120'));

  // Replaying does not pile up previous OpenAlgo widget chrome/canvases.
  if (await page.locator('#basket-chart .oac-widget').count() !== 1) {
    throw new Error('Replay leaked duplicate OpenAlgo chart instances');
  }

  await page.screenshot({ path: resolve(images, 'studio-integrated-risk-paper-replay.png'), fullPage: true });


  await page.locator('#toolbar-builder').click();
  await page.locator('#strangle').click();
  await page.locator('#render').click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized'),
    null, { timeout: 25000 });
  const legStrikes = await page.locator('#basket-title').innerText();
  if (!legStrikes.includes('CE') || !legStrikes.includes('PE')) {
    throw new Error('Preset did not refresh simulated option legs');
  }
  await page.locator('#toolbar-workspaces').click();
  await page.locator('#workspace-name').fill('Synthetic Test Workspace');
  await page.locator('#save').click();
  if (!await page.locator('#saved-list').innerText().then(s => s.includes('Synthetic Test Workspace'))) {
    throw new Error('Browser workspace not saved');
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized'),
    null, { timeout: 25000 });
  if (!(await page.locator('#saved-list').innerText()).includes('Synthetic Test Workspace')) {
    throw new Error('Local browser workspace did not survive reload');
  }
  await page.locator('#toolbar-underlying').selectOption('BANKNIFTY');
  await page.waitForFunction(() => document.querySelector('#atm')?.textContent?.includes('strike step 100'));
  await page.locator('#toolbar-render').click();
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Loaded 120 synchronized') &&
    document.querySelector('#basket-title')?.textContent?.includes('BANKNIFTY'),
    null, { timeout: 25000 });
  const bad = await page.request.get(origin + '/qsyn/api/v1/studio/bars?underlying=NIFTY&legs=%5B%5D');
  if (bad.status() !== 422) throw new Error('Malformed strategy accepted at HTTP boundary');
  const post = await page.request.post(origin + '/qsyn/api/v1/studio/market');
  if (post.status() !== 405) throw new Error('Simulated market accepted non-readonly mutation');
  const app = await page.request.get(origin + '/qsyn/app');
  if (app.status() !== 404) throw new Error('Private mock-account dashboard inadvertently enabled');
  if (errors.length) throw new Error('Studio browser console errors: ' + errors.join('; '));
  await page.screenshot({ path: resolve(images, 'studio-banknifty.png'), fullPage: true });
  console.log('PASS: integrated option chain, simulated three-panel charts, strangle preset, local workspaces, bank switching, API denials and disabled accounts');
} finally {
  await browser?.close();
  php?.kill('SIGTERM');
  await unlink(asset).catch(() => {});
}

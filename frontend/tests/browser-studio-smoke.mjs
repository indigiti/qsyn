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
  await page.screenshot({ path: resolve(images, 'studio-straddle.png'), fullPage: true });

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
  await page.locator('#underlying').selectOption('BANKNIFTY');
  await page.waitForFunction(() => document.querySelector('#atm')?.textContent?.includes('strike step 100'));
  await page.locator('#render').click();
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

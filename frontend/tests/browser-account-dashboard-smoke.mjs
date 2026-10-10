// Browser acceptance: real OpenAlgo candlesticks against session-owned
// simulated accounts only. No real providers or live trading.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const project = resolve(import.meta.dirname, '../..');
const accountBundle = resolve(project, 'frontend/dist/account-chart.js');
const asset = resolve(project, 'apps/web-php/public/assets/account-chart.js');
const sourcePassword = 'test-only-strong-password-123456';
const images = resolve(project, 'frontend/artifacts');
const failures = [];
let server;
let browser;
let scratch;

async function port() {
  return new Promise((done, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const assigned = s.address().port;
      s.close(() => done(assigned));
    });
  });
}

async function waitReady(origin) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(origin + '/qsyn/api/v1/health')).ok) return;
    } catch {}
    await delay(125);
  }
  throw new Error('Temporary QSYN PHP server not ready');
}

function createFixture(env, directory, tenant, username, role) {
  const php = [
    "require 'apps/web-php/src/FileStore.php';",
    "require 'apps/web-php/src/UserRepository.php';",
    "require 'apps/web-php/src/FileUserRepository.php';",
    '$u=new QSYN\\Identity\\FileUserRepository(new QSYN\\Storage\\FileStore($argv[1]));',
    '$u->createFixture($argv[2],$argv[3],$argv[4],$argv[5]);',
  ].join('\n');
  execFileSync('php', ['-r', php, directory, tenant, username, sourcePassword, role],
    { cwd: project, env });
}

function launch(env, sessions, assigned) {
  return spawn('php', [
    '-d', 'session.save_path=' + sessions,
    '-S', '127.0.0.1:' + assigned,
    '-t', 'apps/web-php/public', 'apps/web-php/dev-router.php',
  ], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function signIn(page, origin, tenant, username) {
  await page.goto(origin + '/qsyn/app', { waitUntil: 'networkidle' });
  await page.locator('#sign-in').waitFor({ state: 'visible' });
  await page.locator('#tenant-input').fill(tenant);
  await page.locator('#user-input').fill(username);
  await page.locator('#password-input').fill(sourcePassword);
  await page.locator('#login-button').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
}

async function add(page, broker, reference, label) {
  await page.locator('#broker-input').selectOption(broker);
  await page.locator('#reference-input').fill(reference);
  await page.locator('#label-input').fill(label);
  await page.locator('#add-button').click();
  await page.waitForFunction(text => [...document.querySelectorAll('.account-name')]
    .some(el => el.textContent === text), label);
}

async function painted(page) {
  return page.locator('#account-chart').evaluate(root => {
    const canvases = root.querySelectorAll('canvas');
    let red = 0, green = 0;
    for (const canvas of canvases) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !canvas.width || !canvas.height) continue;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 96) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (g > 60 && g > r * 1.18 && g > b * .92) green++;
        if (r > 92 && r > g * 1.24 && r > b * 1.10) red++;
      }
    }
    return { canvasCount: canvases.length, red, green };
  });
}

try {
  scratch = await mkdtemp(join(tmpdir(), 'qsyn-dashboard-browser-'));
  const privateDir = join(scratch, 'private');
  const sessions = join(scratch, 'sessions');
  await mkdir(privateDir, { mode: 0o700 });
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(images, { recursive: true });
  await copyFile(accountBundle, asset);
  const env = {
    ...process.env,
    QSYN_ENV: 'test',
    QSYN_ALLOW_HTTP_TEST: '1',
    QSYN_IDENTITY_ENABLED: '1',
    QSYN_MOCK_ACCOUNTS_ENABLED: '1',
    QSYN_DASHBOARD_ENABLED: '1',
    QSYN_IDENTITY_STORAGE_DIR: privateDir,
  };
  createFixture(env, privateDir, 'tenant-one', 'alice', 'member');
  createFixture(env, privateDir, 'tenant-one', 'bob', 'viewer');
  createFixture(env, privateDir, 'tenant-two', 'alice', 'member');

  const assigned = await port();
  const origin = 'http://127.0.0.1:' + assigned;
  server = launch(env, sessions, assigned);
  await waitReady(origin);
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', e => failures.push(String(e)));
  await signIn(page, origin, 'tenant-one', 'alice');

  if (!(await page.locator('#chart-empty').isVisible())) {
    throw new Error('Chart must not render without selected session-owned account');
  }
  await add(page, 'upstox', 'mock-upstox-a', 'Upstox A');
  await add(page, 'upstox', 'mock-upstox-b', 'Upstox B');
  await add(page, 'dhan', 'mock-dhan-c', 'Dhan mock');
  if (await page.locator('#account-list .account-item').count() !== 3) {
    throw new Error('Mock account workspace did not show three linked identities');
  }
  const aCard = page.locator('.account-item', { hasText: 'Upstox A' });
  const aId = await aCard.getAttribute('data-account-id');
  await aCard.getByRole('button', { name: 'Select chart' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#chart-source-label')?.textContent.includes('Upstox A')
      && !document.querySelector('#account-chart')?.hidden, null, { timeout: 16000 });
  await page.waitForTimeout(1100);
  const firstPaint = await painted(page);
  if (firstPaint.green < 25 || firstPaint.red < 25) {
    const detail = await page.evaluate(async () => {
      const response = await fetch('/qsyn/api/v1/accounts/bars', { credentials: 'same-origin' });
      const data = await response.json();
      const root = document.getElementById('account-chart');
      const rect = root.getBoundingClientRect();
      return {
        status: response.status, source: data.source, mode: data.mode,
        account: data.account_id, bars: data.bars?.length,
        dimensions: { width: rect.width, height: rect.height },
        chartText: root.innerText.slice(0, 400),
        canvases: [...root.querySelectorAll('canvas')].map(c => ({
          width: c.width, height: c.height,
          css: { display: getComputedStyle(c).display, opacity: getComputedStyle(c).opacity },
        })),
      };
    });
    await page.screenshot({ path: resolve(images, 'account-dashboard-debug.png'), fullPage: true });
    throw new Error('Selected mock account failed to paint candlesticks: ' +
      JSON.stringify({ ...firstPaint, detail, pageErrors: failures }));
  }
  const firstBars = await page.evaluate(async () =>
    (await fetch('/qsyn/api/v1/accounts/bars', { credentials: 'same-origin' })).json());
  if (firstBars.source !== 'account-scoped-mock-fixture' || firstBars.account_id !== aId
      || firstBars.trading_enabled !== false || firstBars.bars.length !== 120) {
    throw new Error('Chart received untrusted or non-selected account provenance');
  }
  await page.screenshot({ path: resolve(images, 'account-dashboard-mock-upstox.png'), fullPage: true });

  // Server-side workspace persistence: the setting belongs to mock Upstox A
  // and survives page reloads, unlike per-browser unscoped localStorage.
  await page.locator('#workspace-theme').selectOption('light');
  await page.locator('#workspace-visible').selectOption('60');
  await page.locator('#workspace-layout').selectOption('focus');
  await page.locator('#workspace-save').click();
  await page.waitForFunction(() =>
    document.querySelector('#workspace-grid')?.classList.contains('focus') &&
    document.querySelector('#workspace-visible')?.value === '60', null, { timeout: 16000 });
  if (await page.locator('.accounts-panel').isVisible()) {
    throw new Error('Focused workspace still shows broker management panel');
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() =>
    document.querySelector('#workspace-grid')?.classList.contains('focus') &&
    document.querySelector('#workspace-theme')?.value === 'light' &&
    document.querySelector('#workspace-visible')?.value === '60' &&
    document.querySelector('#chart-source-label')?.textContent.includes('Upstox A'),
    null, { timeout: 16000 });
  const savedA = await page.evaluate(async () =>
    (await fetch('/qsyn/api/v1/accounts/workspace', { credentials: 'same-origin' })).json());
  if (savedA.workspace.revision !== 1 ||
      savedA.workspace.account_id !== aId ||
      savedA.workspace.settings.layout !== 'focus' ||
      savedA.workspace.settings.theme !== 'light' ||
      savedA.workspace.settings.visible_bars !== 60) {
    throw new Error('Reload did not restore saved server-owned mock workspace');
  }
  await page.screenshot({ path: resolve(images, 'account-dashboard-saved-focus.png'), fullPage: true });
  await page.locator('#show-accounts-button').click();
  if (!(await page.locator('.accounts-panel').isVisible())) {
    throw new Error('Focused layout trapped account navigation');
  }


  const bCard = page.locator('.account-item', { hasText: 'Upstox B' });
  const bId = await bCard.getAttribute('data-account-id');
  await bCard.getByRole('button', { name: 'Select chart' }).click();
  await page.waitForFunction(expectedId =>
    document.querySelector('#chart-source-label')?.textContent.includes('Upstox B') &&
    !!document.querySelector('.account-item.selected[data-account-id="' + expectedId + '"]'),
    bId, { timeout: 16000 });
  await page.waitForFunction(() =>
    document.querySelector('#workspace-theme')?.value === 'dark' &&
    document.querySelector('#workspace-visible')?.value === '100' &&
    !document.querySelector('#workspace-grid')?.classList.contains('focus'),
    null, { timeout: 16000 });
  const secondBars = await page.evaluate(async () =>
    (await fetch('/qsyn/api/v1/accounts/bars', { credentials: 'same-origin' })).json());
  if (secondBars.account_id !== bId || JSON.stringify(firstBars.bars) === JSON.stringify(secondBars.bars)) {
    throw new Error('Switching mock accounts reused prior owner/chart fixture');
  }
  await page.locator('.account-item.selected').getByRole('button', { name: 'Rename' }).click();
  await page.locator('.rename-form input').fill('Upstox B test <script>alert(1)</script>');
  await page.locator('.rename-form button[type="submit"]').click();
  await page.waitForFunction(() => document.body.innerText.includes('Upstox B test <script>'));
  if (await page.locator('.account-item script').count() > 0) {
    throw new Error('Mock account label was inserted as HTML instead of text');
  }
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.account-item.selected').getByRole('button', { name: 'Disconnect' }).click();
  await page.waitForFunction(() =>
    !document.querySelector('#chart-empty')?.hidden &&
    document.querySelector('#chart-source-label')?.textContent.includes('No mock chart source'),
    null, { timeout: 16000 });
  const denied = await page.evaluate(async () =>
    (await fetch('/qsyn/api/v1/accounts/bars', { credentials: 'same-origin' })).status);
  if (denied !== 409) throw new Error('Disconnected mock source still serving bars');

  // Independent contexts, not just hidden DOM: other user and tenant must not
  // receive the owner's account list, even when requesting bars directly.
  for (const [tenant, username, readonly] of [
    ['tenant-one', 'bob', true], ['tenant-two', 'alice', false],
  ]) {
    const isolated = await browser.newContext();
    const userPage = await isolated.newPage();
    userPage.on('pageerror', e => failures.push(String(e)));
    await signIn(userPage, origin, tenant, username);
    if (await userPage.locator('.account-item').count() !== 0) {
      throw new Error('Cross-user or cross-tenant mock accounts leaked into dashboard');
    }
    if ((await userPage.evaluate(async () =>
      (await fetch('/qsyn/api/v1/accounts/bars', { credentials: 'same-origin' })).status)) !== 409) {
      throw new Error('Foreign account history leaked through selected-chart API');
    }
    if (readonly && !(await userPage.locator('#add-form').isHidden())) {
      throw new Error('Viewer must not receive account mutation interface');
    }
    await isolated.close();
  }

  // The original user's saved Upstox A workspace remains independent of
  // Upstox B and other user logins even after the B account was disconnected.
  await page.locator('.account-item', { hasText: 'Upstox A' })
    .getByRole('button', { name: 'Select chart' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#chart-source-label')?.textContent.includes('Upstox A') &&
    document.querySelector('#workspace-grid')?.classList.contains('focus') &&
    document.querySelector('#workspace-visible')?.value === '60',
    null, { timeout: 16000 });

  await page.locator('#signout-button').click();
  await page.locator('#sign-in').waitFor({ state: 'visible' });
  await signIn(page, origin, 'tenant-one', 'alice');
  await page.waitForFunction(() =>
    document.querySelector('#chart-source-label')?.textContent.includes('Upstox A') &&
    document.querySelector('#workspace-theme')?.value === 'light' &&
    document.querySelector('#workspace-visible')?.value === '60',
    null, { timeout: 16000 });
  await page.locator('#signout-button').click();
  await page.locator('#sign-in').waitFor({ state: 'visible' });
  if (!(await page.locator('#workspace').isHidden())) throw new Error('Logout left workspace visible');
  const result = await page.evaluate(async () =>
    (await fetch('/qsyn/api/v1/accounts/list', { credentials: 'same-origin' })).status);
  if (result !== 401) throw new Error('Logged-out user retained account access');
  if (failures.length) throw new Error('Browser JS errors: ' + failures.join('; '));
  console.log('PASS: dashboard login, workspace save/restore, chart painting, switching, isolation, disconnect, logout');
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  await unlink(asset).catch(() => {});
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

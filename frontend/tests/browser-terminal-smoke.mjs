// Database-free OpenAlgo-style QSYN terminal browser acceptance.
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const assets = resolve(root, 'apps/web-php/public/assets');
const browserErrors = [];
const browserRequests = [];
let server, browser;

function findPort() {
  return new Promise((resolvePort, reject) => {
    const x = createServer();
    x.once('error', reject);
    x.listen(0, '127.0.0.1', () => {
      const port = x.address().port;
      x.close(() => resolvePort(port));
    });
  });
}
async function ready(origin) {
  for(let i=0;i<50;i++) {
    try { if ((await fetch(origin+'/qsyn/api/v1/health')).ok) return; } catch {}
    await delay(120);
  }
  throw new Error('PHP service did not become ready');
}
try {
  await mkdir(assets,{recursive:true});
  for(const ext of ['js','css'])
    await copyFile(resolve(root,'frontend/dist/terminal.'+ext),resolve(assets,'terminal.'+ext));

  const port=await findPort(), origin='http://127.0.0.1:'+port;
  const adminPassword='ci-test-only-terminal-password-123456';
  const adminHash=execFileSync('php',['-r','echo password_hash($argv[1], PASSWORD_DEFAULT);',adminPassword],{encoding:'utf8'}).trim();
  server=spawn('php',['-S','127.0.0.1:'+port,'-t','apps/web-php/public','apps/web-php/dev-router.php'],{
    cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,QSYN_ALLOW_HTTP_TEST:'1',QSYN_CONTROL_ENABLED:'1',QSYN_ADMIN_PASSWORD_HASH:adminHash}
  });
  await ready(origin);
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  page.on('pageerror',e=>browserErrors.push(e.message));
  page.on('request',r=>browserRequests.push(r.url()));
  // Homepage uses native OpenAlgo Charts 2.6 grid and a strict public crypto
  // catalog. In CI Rust is not started: failure must NOT produce fake candles.
  const response=await page.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded',timeout:25000});
  if(response.status()!==200) throw new Error('QSYN homepage returned '+response.status());
  // PHP's public chart template must never include inline scripts: CSP
  // script-src 'self' is deliberately strict, so host-injected inline script
  // blocks should be diagnosed outside the QSYN bundle, not whitelisted.
  const firstHtml=await response.text();
  const inlineScript=/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i;
  if(inlineScript.test(firstHtml))
    throw new Error('QSYN homepage emitted an inline script prohibited by its own CSP');
  if(!String(response.headers()['content-security-policy']||'').includes("script-src 'self'"))
    throw new Error('QSYN homepage CSP script policy unexpectedly weakened');
  const homeNonce=String(response.headers()['content-security-policy']||'')
    .match(/script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/);
  if(!homeNonce || !firstHtml.includes('nonce="'+homeNonce[1]+'"'))
    throw new Error('Homepage must bind a fresh CSP nonce to its terminal bundle');
  if(String(response.headers()['cache-control']||'').includes('no-transform'))
    throw new Error('Homepage unexpectedly disabled Cloudflare JavaScript Detections');

  if(new URL(page.url()).pathname!=='/qsyn/') throw new Error('Homepage redirected');
  const alternate=await page.request.get(origin+'/qsyn/terminal',{maxRedirects:0});
  if(alternate.status()!==303 || alternate.headers().location!=='/qsyn/terminal/login')
    throw new Error('Unauthenticated terminal leaked before admin login');
  // All legacy workspace aliases must also require the admin password.
  for (const old of ['/qsyn/studio','/qsyn/admin/rust','/qsyn/legacy-chart']) {
    const denied=await page.request.get(origin+old,{maxRedirects:0});
    if(denied.status()!==303 || denied.headers().location!=='/qsyn/terminal/login')
      throw new Error('Retired alias bypassed password gate: '+old);
  }
  // Existing alias redirects are still preserved after login.
  await page.goto(origin+'/qsyn/terminal',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Administrator sign-in'}).waitFor();
  await page.getByLabel('QSYN administrator password').fill(adminPassword);
  await page.getByRole('button',{name:'Unlock terminal'}).click();
  if(new URL(page.url()).pathname==='/qsyn/terminal/login')
    throw new Error('Administrator unlock returned login instead of terminal: '+(await page.locator('body').innerText()).slice(0,420));
  await page.getByRole('heading',{name:'Market explorer'}).waitFor();
  // Transient admin API 503 must not forcibly log out a valid administrator.
  await page.route('**/qsyn/api/v1/admin/rust/state',async route=>{
    await route.fulfill({status:503,contentType:'application/json',
      body:JSON.stringify({error:'temporary_unavailable'})});
  });
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.getByText('Session check unavailable.').waitFor({timeout:7000});
  if(new URL(page.url()).pathname==='/qsyn/terminal/login')
    throw new Error('Temporary admin API failure incorrectly triggered a login redirect');
  await page.unroute('**/qsyn/api/v1/admin/rust/state');
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.getByText('Session check unavailable.').waitFor({state:'detached',timeout:7000});
  const auditResponse=await page.request.get(origin+'/qsyn/api/v1/admin/diagnostics/report');
  if(auditResponse.status()!==200)throw Error('Authenticated diagnostic endpoint unavailable');
  const audit=await auditResponse.json();
  if(audit.schema!=='QSYN-ADMIN-DIAGNOSTICS/1'||!audit.request_id||audit.trading_enabled!==false)
    throw Error('Sanitized administrator audit contract failed');

  for (const [old,view] of [
    ['/qsyn/legacy-chart','diagnostics'],
    ['/qsyn/legacy-chart/','diagnostics'],
    ['/qsyn/admin/rust','operations'],
    ['/qsyn/admin/rust/','operations'],
    ['/qsyn/studio','strategy'],
    ['/qsyn/studio/','strategy'],
  ]) {
    const retired=await page.request.get(origin+old,{maxRedirects:0});
    if(retired.status()!==302||
        retired.headers().location!=='/qsyn/terminal/'+view||
        !String(retired.headers()['cache-control']||'').includes('no-store'))
      throw new Error('Standalone dashboard remains active or cacheable: '+old);
    const invalidMethod=await page.request.post(origin+old,{maxRedirects:0});
    if(invalidMethod.status()!==405)
      throw new Error('Retired dashboard unexpectedly accepted POST: '+old);
  }
  // Return to the public homepage before its native-grid rendering checks.
  await page.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded'});
  const blockedPost=await page.request.post(origin+'/qsyn/');
  if(blockedPost.status()!==405)throw new Error('Homepage accepted POST');
  if(!String(response.headers()['content-security-policy']).includes("connect-src 'self'"))
    throw new Error('Same-origin CSP missing');
  if(!String(response.headers()['x-robots-tag']).includes('noindex'))throw new Error('Staging exposed');
  // No QSYN-created selectors: OpenAlgo owns symbol search, grid layouts
  // and watchlist. The native actions must be icon-only and colocated.
  if(await page.locator('.qsyn-crypto-selector').count()!==0)
    throw new Error('Duplicate homepage exchange and grid dropdowns remain');
  await page.waitForFunction(()=>document.querySelectorAll('.qsyn-crypto-grid canvas').length>0,null,{timeout:12000});
  await page.locator('.qsyn-home-chart .oac-sym input').first().waitFor({timeout:12000});
  const arrange=page.locator('.qsyn-home-chart .oac-grid__bar .oac-grid__layout').first();
  const saved=page.locator('.qsyn-home-chart .oac-grid__bar .oac-grid__saved').first();
  const watchlist=page.locator('.qsyn-home-chart .oac-topbar .oac-topbar__watchlist').first();
  await arrange.waitFor({state:'visible',timeout:15000});
  await saved.waitFor({state:'visible',timeout:15000});
  await watchlist.waitFor({state:'visible',timeout:15000});
  const joined=await arrange.evaluate(el=>{
    const a=el.getBoundingClientRect();
    const s=el.parentElement.querySelector('.oac-grid__saved').getBoundingClientRect();
    const w=document.querySelector('.qsyn-home-chart .oac-topbar__watchlist').getBoundingClientRect();
    return {near:s.right<=w.left+4&&w.left-s.right<20,
      sameRow:Math.abs(a.top-w.top)<5,
      textVisible:getComputedStyle(el.querySelector('.oac-grid__bar-text')).display,
      tooltip:el.getAttribute('aria-label')};
  });
  if(!joined.near || !joined.sameRow || joined.textVisible!=='none' || !joined.tooltip)
    throw new Error('Native icon-only Layouts not beside Watchlist: '+JSON.stringify(joined));
  await arrange.click();
  await page.locator('.oac-grid__picker[role="menu"]').waitFor({timeout:12000});
  await page.keyboard.press('Escape');

  // End-to-end dialog acceptance for the *actual* OpenAlgo grid on /qsyn/.
  // Previous tests exercised Layouts/Watchlist but missed chart settings,
  // indicator picker, and the per-indicator Settings action altogether.
  const chartSettings=page.locator('.qsyn-home-chart .oac-topbar button[aria-label="Chart settings"]').first();
  await chartSettings.click();
  const chartDialog=page.locator('.qsyn-home-chart .oac-settings[role="dialog"]');
  await chartDialog.waitFor({state:'visible',timeout:12000});
  if(!await chartDialog.locator('.oac-form .oac-row').count())
    throw new Error('Native chart settings dialog has no usable controls');
  await chartDialog.getByRole('button',{name:'Cancel'}).click();
  await chartDialog.waitFor({state:'detached'});

  const indicators=page.locator('.qsyn-home-chart .oac-topbar button[aria-label="Indicators"]').first();
  await indicators.click();
  const picker=page.locator('.qsyn-home-chart .oac-pick');
  await picker.waitFor({state:'visible',timeout:12000});
  await picker.locator('input[aria-label="Search indicators"]').fill('Wick Science');
  await picker.locator('.oac-pick__row').first().click();
  await picker.getByRole('button',{name:'Done'}).click();
  await picker.waitFor({state:'detached'});
  await page.locator('.qsyn-home-chart .oac-topbar__objects').first().click();
  const studySettings=page.locator('.qsyn-home-chart .oac-objects__row[data-object-id^="indicator:"] button[data-action="settings"]').first();
  await studySettings.waitFor({state:'visible',timeout:12000});
  await studySettings.click();
  const studyDialog=page.locator('.qsyn-home-chart .oac-indset[role="dialog"]');
  await studyDialog.waitFor({state:'visible',timeout:12000});
  if(!await studyDialog.locator('.oac-form .oac-row').count())
    throw new Error('Native indicator settings dialog did not render the study inputs');
  await studyDialog.getByRole('button',{name:'Cancel'}).click();
  await studyDialog.waitFor({state:'detached'});
  await page.locator('.qsyn-home-chart .oac-topbar__objects').first().click();

  await watchlist.click();
  await page.waitForFunction(()=>!!document.querySelector('.oac-watchlist, .oac-watchlist-panel, .oac-panel-dock'),null,{timeout:12000});
  const invalid=await page.request.get(origin+'/qsyn/api/v1/crypto/bars?exchange=BAD&market=spot&symbol=../../secret&interval=1m');
  if(invalid.status()!==422)throw new Error('Crypto proxy did not reject unsupported path');
  if(await page.locator('.qsyn-homepage .terminal-sidebar').count())throw new Error('Homepage gained dashboard navigation');
  if(await page.locator('html').getAttribute('data-qsyn-theme')!=='light')throw new Error('First-visit light theme lost');
  // The /qsyn/terminal route retains existing chart compare, watchlist,
  // private-workspace and broker-safety behavior.
  await page.goto(origin+'/qsyn/terminal/trading',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Legacy Chart Lab'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('#qsyn-native-chart canvas').length>0,
    null,{timeout:12000});
  const source = await page.locator('.terminal-alert').innerText();
  if(!source.includes('Research-only workspace')||!source.includes('Simulated data'))
    throw new Error('Missing unambiguous simulation provenance label');
  if(await page.locator('.terminal-nav-item.locked:disabled').count()!==0)
    throw new Error('Retired broker/order navigation is still displayed');
  // Chart compare and AT-MONEY synthetic demos use only whitelisted public simulations.
  await page.getByRole('button',{name:'Compare two charts'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#qsyn-secondary-chart canvas').length>0);
  await Promise.all([
    page.waitForResponse(r=>r.url().includes('/qsyn/api/v1/studio/bars?') && r.url().includes('BANKNIFTY') && r.status()===200,{timeout:12000}),
    page.getByRole('combobox',{name:'Comparison instrument'}).selectOption('QSYN-BANKNIFTY-STRADDLE'),
  ]);
  await page.getByRole('textbox',{name:'Layout name'}).fill('Simulated pair');
  await page.getByRole('button',{name:'Save layout'}).click();
  await page.getByRole('textbox',{name:'Find simulated instruments'}).fill('FINNIFTY');
  if(await page.locator('.terminal-search-row').count()!==1)
    throw new Error('Instrument search did not stay inside approved demo registry');
  await page.getByRole('button',{name:'Watch QSYN-FINNIFTY-STRADDLE'}).click();
  if(await page.locator('.terminal-watch-row').count()!==3)
    throw new Error('Browser watchlist add failed');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('combobox',{name:'Saved layouts'}).selectOption('Simulated pair');
  await page.waitForFunction(()=>document.querySelectorAll('#qsyn-secondary-chart canvas').length>0);
  if(await page.locator('.terminal-watch-row').count()!==3)
    throw new Error('Browser-local watchlist did not survive reload');
  if(await page.getByRole('combobox',{name:'Comparison instrument'}).inputValue()!=='QSYN-BANKNIFTY-STRADDLE')
    throw new Error('Named layout did not restore synthetic comparison');
  await page.getByRole('button',{name:'Single chart'}).click();
  if(await page.locator('#qsyn-secondary-chart').count()!==0)
    throw new Error('Second chart remained after comparison disabled');
  const raw=await page.request.post(origin+'/qsyn/terminal');
  if(raw.status()!==405)throw new Error('Terminal accepted POST');
  const bundle=await page.locator('script[src*="/assets/terminal.js"]').getAttribute('src');
  if(!/terminal[.]js[?]v=[0-9]+/.test(bundle))
    throw new Error('Terminal bundle is not cache-versioned');
  await page.getByRole('button',{name:'Toggle theme'}).click();
  if(await page.locator('html').getAttribute('data-qsyn-theme')!=='light')
    throw new Error('Light theme did not activate');
  await page.goto(origin+'/qsyn/terminal/dashboard',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Command center'}).waitFor();
  if(new URL(page.url()).pathname!=='/qsyn/terminal/dashboard')throw new Error('Dashboard deep link failed');
  if(!(await page.getByText('SIMULATION ONLY').count()))
    throw new Error('Dashboard simulation provenance label missing');
  await page.waitForFunction(()=>document.querySelectorAll('.qd-chart-preview #qsyn-native-chart canvas').length>0);
  if(!(await page.getByRole('heading',{name:'Synthetic premium workspace'}).count()))
    throw new Error('Dashboard lost chart preview');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Command center'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.qd-chart-preview #qsyn-native-chart canvas').length>0);
  await page.goto(origin+'/qsyn/terminal/tools',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Tools'}).waitFor();
  if(!(await page.getByRole('button',{name:/Strategy Studio/}).count()>0))
    throw new Error('Unified Strategy Studio tool missing');
  // Public terminal stays browser-only without opt-in identity/private storage.
  await page.goto(origin+'/qsyn/terminal/trading',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Legacy Chart Lab'}).waitFor();
  if(await page.getByRole('button',{name:'Load private file'}).count()!==0)
    throw new Error('Private workspace controls unexpectedly available without authentication');

  // Stub an authenticated PRIVATE developer response in an isolated tab;
  // loading it must never copy owner-scoped layout data to the shared local key.
  // A private tab must share only the administrator SESSION COOKIE, never
  // the previous public browser's localStorage/watchlist state.
  const signedState = await context.storageState();
  const privateContext = await browser.newContext({
    viewport:{width:1280,height:800},
    storageState:{cookies:signedState.cookies,origins:[]},
  });
  const privatePage = await privateContext.newPage();
  privatePage.on('pageerror',e=>browserErrors.push(e.message));
  const privateSnapshot = {
    schema:'QSYN-TERMINAL-BROWSER-WORKSPACES/1',
    watchlist:['QSYN-FINNIFTY-STRADDLE'],
    layouts:[{name:'Private unique',panes:[{id:'primary',symbol:'QSYN-FINNIFTY-STRADDLE'}],chartStates:{}}],
  };
  const requests=[];
  let privateReads=0;
  await privatePage.route('**/qsyn/api/v1/terminal/workspace', async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      const body=req.postDataJSON();requests.push(body);
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({mode:'simulated',storage:'private_file_development_only',
          revision:1,workspace:body.workspace})});
    } else {
      privateReads++;
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({mode:'simulated',storage:'private_file_development_only',
          revision:0,csrf:'a'.repeat(64),can_write:true,workspace:privateSnapshot})});
    }
  });
  await privatePage.goto(origin+'/qsyn/terminal/trading',{waitUntil:'domcontentloaded'});
  await privatePage.getByRole('heading',{name:'Legacy Chart Lab'}).waitFor();
  if(privateReads!==0)
    throw new Error('Private development workspace was probed without operator opt-in');
  await privatePage.getByRole('button',{name:'Refresh private file status'}).click();
  await privatePage.getByRole('button',{name:'Load private file'}).waitFor();
  if(privateReads!==1)
    throw new Error('Private development workspace opt-in did not fetch exactly once');
  await privatePage.getByRole('button',{name:'Load private file'}).click();
  await privatePage.locator('select[aria-label="Saved layouts"] option[value="Private unique"]').waitFor({state:'attached'});
  if(await privatePage.locator('.terminal-watch-row').count()!==1)
    throw new Error('Private layout was not imported to memory');
  const leak=await privatePage.evaluate(()=>localStorage.getItem('qsyn-terminal-browser-workspaces-v2'));
  if(leak?.includes('Private unique') || leak?.includes('FINNIFTY'))
    throw new Error('Private owner workspace leaked into unscoped localStorage');
  await privatePage.getByRole('button',{name:'Save private file'}).click();
  await privatePage.getByText(/Private file saved at revision 1/).waitFor();
  if(requests.length!==1 || Object.keys(requests[0]).sort().join(',')!=='expected_revision,workspace')
    throw new Error('Private file sync made an unsafe or incorrect write request');
  await privatePage.getByRole('button',{name:'Return to browser'}).click();
  if(await privatePage.locator('select[aria-label="Saved layouts"] option[value="Private unique"]').count()!==0)
    throw new Error('Private owner workspace remained visible after returning to browser');
  await privatePage.close();
  await privateContext.close();
  // Homepage index selection survives the password-protected Terminal
  // transition with public alias ONLY (no bearer/account/private key).
  await page.evaluate(()=>sessionStorage.setItem('qsyn-public-index-intent-v1','NSE_INDEX:index:NIFTY'));
  await page.route('**/qsyn/api/v1/admin/upstox/private-chart-access',async route=>{
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      schema:'QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1',profile:'operator-admin',
      authenticated:true,account_id:'fixture-account',csrf:'a'.repeat(64),
      trading_enabled:false,
    })});
  });
  await page.goto(origin+'/qsyn/terminal/markets',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Market explorer'}).waitFor();
  if(await page.getByRole('button',{name:'Indices',exact:true}).getAttribute('aria-pressed')!=='true')
    throw new Error('Homepage NIFTY selection did not open India indices');
  if(await page.getByRole('combobox',{name:'Market instrument'}).inputValue()!=='NSE_INDEX:index:NIFTY')
    throw new Error('Selected NIFTY was lost across administrator navigation');
  await page.getByRole('textbox',{name:'Private index instrument key'}).waitFor();
  if(await page.getByRole('textbox',{name:'Private index instrument key'}).inputValue()!=='NSE_INDEX|Nifty 50')
    throw new Error('Private NIFTY candidate key not prefilled for explicit grant validation');
  const reused=await page.evaluate(()=>sessionStorage.getItem('qsyn-public-index-intent-v1'));
  if(reused!==null)throw new Error('Index handoff intent was not consumed');
  if(await page.locator('.terminal-private-chart-grid').count()!==0)
    throw new Error('Private index stream started without explicit approval');
  await page.unroute('**/qsyn/api/v1/admin/upstox/private-chart-access');
  // Unified shell: no iframe, redirect or new page for markets, strategies,
  // broker readiness, diagnostics, operations or saved workspaces.
  await page.goto(origin+'/qsyn/terminal?view=diagnostics',{waitUntil:'domcontentloaded'});
  if(new URL(page.url()).pathname!=='/qsyn/terminal/diagnostics')
    throw new Error('Old query URL was not canonicalized');
  await page.getByRole('heading',{name:'Diagnostics & feed health'}).waitFor();
  if(await page.locator('.qt-table tbody tr').count()!==7)
    throw new Error('Seven crypto worker diagnostics not rendered');
  if(await page.locator('iframe').count())throw new Error('Unified terminal used iframe');
  // Reproduce the real configured Upstox operator state. Without this mock,
  // unconfigured CI never renders the gated Search icon, and an undefined
  // component name can break the entire Brokers page on a real deployment.
  let indexDiscoverCalls=0;
  await page.route('**/qsyn/api/v1/admin/upstox/status',async route=>{
    await route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({
        schema:'QSYN-NATIVE-UPSTOX-WEB/1',
        configured:true,token_stored:true,
        csrf:'f'.repeat(64),
        provider_user_id_checked_at_exchange:true,
        index_feed_activated:false,trading_enabled:false,
      })});
  });
  await page.route('**/qsyn/api/v1/admin/upstox/discover',async route=>{
    const req=route.request(); indexDiscoverCalls++;
    if(req.method()!=='POST'||req.headers()['x-csrf-token']!=='f'.repeat(64)
      ||req.postData()!=='{}')
      throw new Error('Native Upstox index lookup lost POST / CSRF / empty object contract');
    await route.fulfill({status:200,contentType:'application/json',
      headers:{'X-QSYN-Request-ID':'0123456789abcdef'},
      body:JSON.stringify({
        schema:'QSYN-UPSTOX-INDEX-DISCOVERY/1',
        status:'incomplete',code:'UPSTOX_INDEX_KEYS_INCOMPLETE',
        session_verified_now:true,mapping_fully_resolved:false,
        current_bod_attested:false,
        exchange_display_entitlement_verified:false,
        index_feed_activated:false,trading_enabled:false,
        instruments:[{symbol:'NIFTY',exchange:'NSE_INDEX',
          status:'not_found',instrument_key:null}],
      })});
  });
  await page.getByRole('button',{name:'Data Providers & Connections',exact:true}).first().click();
  await page.getByRole('heading',{name:'Data providers & connections'}).waitFor();
  await page.getByRole('heading',{name:'Indian indices · web operations'}).waitFor();
  if(await page.getByRole('button',{name:'Validate six-index plan'}).isEnabled() ||
     await page.getByRole('button',{name:'Import approved historical candles'}).isEnabled() ||
     await page.getByRole('button',{name:'Start worker'}).isEnabled())
    throw new Error('Unprovisioned index web operations unexpectedly executable');

  if(new URL(page.url()).pathname!=='/qsyn/terminal/brokers')
    throw new Error('Broker view not routed in React');
  await page.getByRole('button',{name:'Refresh Upstox status'}).waitFor({timeout:12000});
  if(await page.getByRole('heading',{name:'Configure a private broker/provider'}).count()!==0
    || await page.locator('.qt-broker-grid').count()!==0
    || await page.getByRole('heading',{name:'Configure first OpenAlgo connection'}).count()!==0)
    throw new Error('Unverified OpenAlgo broker selection/setup unexpectedly visible');
  if(await page.getByRole('heading',{name:'Native Upstox → QSYN Rust V3'}).count()!==1)
    throw new Error('Native Upstox configuration was lost');
  const lookupButton=page.getByRole('button',{name:'Discover index instrument keys'});
  await lookupButton.waitFor({state:'visible',timeout:12000});
  if(!await lookupButton.isEnabled())
    throw new Error('Configured Upstox failed to render enabled instrument discovery');
  if(browserErrors.length)
    throw new Error('Configured broker produced a JavaScript exception: '+JSON.stringify(browserErrors));
  await lookupButton.click();
  await page.getByRole('heading',{name:'Upstox NSE/BSE index lookup'}).waitFor();
  if(indexDiscoverCalls!==1)
    throw new Error('Upstox browser discovery action did not send exactly one request');
  if(await page.getByText('UPSTOX_INDEX_KEYS_INCOMPLETE').count()<1)
    throw new Error('Redacted Upstox discovery diagnostic not rendered');
  if(browserErrors.length)
    throw new Error('Upstox discovery UI crashed: '+JSON.stringify(browserErrors));

  // The actual failure occurred on a direct pretty-URL reload after the
  // account was already configured. Keep the mock while testing deep-link.
  const brokerResponse=await page.goto(origin+'/qsyn/terminal/brokers',{waitUntil:'domcontentloaded'});
  if(brokerResponse.status()!==200)
    throw new Error('Protected Brokers HTML returned '+brokerResponse.status());
  const brokerHtml=await brokerResponse.text();
  if(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(brokerHtml))
    throw new Error('QSYN Brokers HTML includes an inline script prohibited by its CSP');
  if(!String(brokerResponse.headers()['content-security-policy']||'')
      .includes("script-src 'self'"))
    throw new Error('Brokers HTML lost its strict script-src CSP');
  const brokersNonce=String(brokerResponse.headers()['content-security-policy']||'')
    .match(/script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/);
  if(!brokersNonce || !brokerHtml.includes('nonce="'+brokersNonce[1]+'"')
      || brokersNonce[1]===homeNonce[1])
    throw new Error('Brokers HTML missing unique CSP nonce or script binding');
  if(String(brokerResponse.headers()['cache-control']||'').includes('no-transform'))
    throw new Error('Brokers unexpectedly disabled Cloudflare JavaScript Detections');
  await page.getByRole('heading',{name:'Data providers & connections'}).waitFor();
  if(await page.locator('.qt-broker-card,.qt-broker-grid').count()!==0 ||
    await page.getByRole('heading',{name:'Configure first OpenAlgo connection'}).count()!==0)
    throw new Error('Unconfigured OpenAlgo controls reappeared on reload');
  await page.getByRole('button',{name:'Discover index instrument keys'}).waitFor({state:'visible'});
  if(browserErrors.length)
    throw new Error('Brokers deep-link crashed: '+JSON.stringify(browserErrors));
  await page.unroute('**/qsyn/api/v1/admin/upstox/status');
  await page.unroute('**/qsyn/api/v1/admin/upstox/discover');
  await page.getByRole('button',{name:'Rust Runtime',exact:true}).first().click();
  await page.getByRole('heading',{name:'Service administration'}).waitFor();
  if(await page.getByRole('button',{name:'Restart',exact:true}).count() &&
     await page.getByRole('button',{name:'Restart',exact:true}).isEnabled())
    throw new Error('Public visitor gained Rust restart privileges');
  await page.getByRole('button',{name:'Strategy Studio',exact:true}).first().click();
  await page.getByRole('heading',{name:'Strategy Studio'}).waitFor();
  await page.getByRole('button',{name:'Render strategy'}).waitFor({state:'visible'});
  await page.getByRole('button',{name:'Render strategy'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.qt-strategy-canvas canvas').length>0,
    null,{timeout:14000});
  if(await page.getByText('Fictional reference points').count()===0)
    throw new Error('Strategy payoff not integrated into React');
  await page.getByRole('button',{name:'Workspaces & Templates',exact:true}).first().click();
  await page.getByRole('heading',{name:'Chart workspaces'}).waitFor();
  await page.getByRole('button',{name:'Route management',exact:true}).first().click();
  await page.getByRole('heading',{name:'Route management'}).waitFor();
  if(new URL(page.url()).pathname!=='/qsyn/terminal/routes'||
     await page.locator('.qt-table tbody tr').count()<11)
    throw new Error('Pretty route directory not mounted');
  await page.goBack({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Chart workspaces'}).waitFor();
  await page.getByRole('button',{name:'Markets',exact:true}).first().click();
  await page.getByRole('heading',{name:'Market explorer'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.terminal-market-embedded canvas').length>0,
    null,{timeout:14000});
  if(new URL(page.url()).pathname!=='/qsyn/terminal/markets')
    throw new Error('Market view escaped unified React terminal');
  // Market-provider registry is unified: non-crypto markets must never
  // substitute demo history for an unlicensed NSE/BSE stream.
  await page.getByRole('button',{name:'Indices',exact:true}).click();
  await page.getByRole('combobox',{name:'Exchange venue'}).selectOption('BSE_INDEX');
  await page.getByRole('combobox',{name:'Market instrument'}).selectOption('BSE_INDEX:index:SENSEX');
  if(await page.getByText('Licensed index chart').count()!==1)
    throw Error('Index chart readiness was not integrated into Markets');
  await page.getByRole('button',{name:'Stocks',exact:true}).click();
  await page.getByText('Stock market adapter not operationally verified').first().waitFor();
  await page.getByRole('button',{name:'Options',exact:true}).click();
  await page.getByRole('button',{name:'Open Strategy Studio'}).click();
  await page.getByRole('heading',{name:'Strategy Studio'}).waitFor();
  await page.getByRole('button',{name:'Markets',exact:true}).first().click();
  await page.getByRole('heading',{name:'Market explorer'}).waitFor();
  // Mobile checks use a separate viewport and storage, but retain the
  // already-authenticated admin cookie so protected terminal routes load.
  const mobileState=await context.storageState();
  const mobileContext=await browser.newContext({
    viewport:{width:390,height:844},
    storageState:{cookies:mobileState.cookies,origins:[]},
  });
  const mobile=await mobileContext.newPage();
  mobile.on('pageerror',e=>browserErrors.push(e.message));
  await mobile.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded'});
  await mobile.waitForFunction(()=>document.querySelectorAll('.qsyn-home-chart canvas').length>0);
  const mobileChartTop=await mobile.locator('.qsyn-home-chart .qsyn-crypto-grid')
    .evaluate(node=>node.getBoundingClientRect().top);
  if(mobileChartTop>8)throw new Error('Mobile chart is not at top of page');
  const mobileChartHeight=await mobile.locator('.qsyn-home-chart .qsyn-crypto-grid')
    .evaluate(node=>node.getBoundingClientRect().height);
  if(mobileChartHeight<830)throw new Error('Mobile chart should fill screen: '+mobileChartHeight);
  if(await mobile.locator('.qsyn-home-chart .terminal-footnote').filter({visible:true}).count())
    throw new Error('Mobile homepage footnotes are visible');
  if(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))
    throw new Error('Full-width homepage overflows on mobile');
  await mobile.goto(origin+'/qsyn/terminal?view=tools',{waitUntil:'domcontentloaded'});
  await mobile.getByRole('button',{name:'Open menu'}).click();
  if(!(await mobile.locator('.terminal-sidebar').getAttribute('class')).includes('show'))
    throw new Error('Mobile menu did not open');
  await mobile.getByRole('button',{name:'Close navigation'}).click();
  await mobile.getByRole('button',{name:'Markets',exact:true}).last().click();
  await mobile.getByRole('heading',{name:'Market explorer'}).waitFor();
  const oversized=await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);
  if(oversized)throw new Error('Terminal overflows on mobile');
  if(browserRequests.some(url=>/(\/api\/v1\/(placeorder|cancelorder|modifyorder)|\/auth\/login|\/socket\.io)/i.test(url)))
    throw new Error('Terminal unexpectedly requested broker, auth or order execution endpoints');
  await mobileContext.close();
  if(browserErrors.length)throw new Error('Browser exceptions: '+JSON.stringify(browserErrors));
  console.log('PASS: full-viewport OpenAlgo-only homepage, legacy rollback, terminal, mobile, CSP and no order calls');
}finally{
  if(browser)await browser.close();
  if(server)server.kill('SIGTERM');
  for(const ext of ['js','css'])await rm(resolve(assets,'terminal.'+ext),{force:true});
}

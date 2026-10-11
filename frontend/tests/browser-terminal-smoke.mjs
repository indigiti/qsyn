// Database-free OpenAlgo-style QSYN terminal browser acceptance.
import { spawn } from 'node:child_process';
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
  server=spawn('php',['-S','127.0.0.1:'+port,'-t','apps/web-php/public','apps/web-php/dev-router.php'],{
    cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,QSYN_ALLOW_HTTP_TEST:'1'}
  });
  await ready(origin);
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>browserErrors.push(e.message));
  page.on('request',r=>browserRequests.push(r.url()));
  // Homepage uses native OpenAlgo Charts 2.6 grid and a strict public crypto
  // catalog. In CI Rust is not started: failure must NOT produce fake candles.
  const response=await page.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded',timeout:25000});
  if(response.status()!==200) throw new Error('QSYN homepage returned '+response.status());
  if(new URL(page.url()).pathname!=='/qsyn/') throw new Error('Homepage redirected');
  const alternate=await page.request.get(origin+'/qsyn/terminal');
  if(alternate.status()!==200)throw new Error('Terminal unavailable');
  const rollback=await page.request.get(origin+'/qsyn/legacy-chart');
  if(rollback.status()!==200)throw new Error('Legacy chart unavailable');
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
  const arrange=page.locator('.qsyn-home-chart .oac-topbar .oac-grid__layout').first();
  const saved=page.locator('.qsyn-home-chart .oac-topbar .oac-grid__saved').first();
  const watchlist=page.locator('.qsyn-home-chart .oac-topbar .oac-topbar__watchlist').first();
  await arrange.waitFor({state:'visible',timeout:15000});
  await saved.waitFor({state:'visible',timeout:15000});
  await watchlist.waitFor({state:'visible',timeout:15000});
  const joined=await arrange.evaluate(el=>({
    saved:el.nextElementSibling?.classList.contains('oac-grid__saved'),
    watchlist:el.nextElementSibling?.nextElementSibling?.classList.contains('oac-topbar__watchlist'),
    textVisible:getComputedStyle(el.querySelector('.oac-grid__bar-text')).display,
    tooltip:el.getAttribute('aria-label')
  }));
  if(!joined.saved || !joined.watchlist || joined.textVisible!=='none' || !joined.tooltip)
    throw new Error('Native Layouts icons were not placed beside Watchlist: '+JSON.stringify(joined));
  await arrange.click();
  await page.locator('.oac-grid__picker[role="menu"]').waitFor({timeout:12000});
  await page.keyboard.press('Escape');
  await watchlist.click();
  await page.waitForFunction(()=>!!document.querySelector('.oac-watchlist, .oac-watchlist-panel, .oac-panel-dock'),null,{timeout:12000});
  const invalid=await page.request.get(origin+'/qsyn/api/v1/crypto/bars?exchange=BAD&market=spot&symbol=../../secret&interval=1m');
  if(invalid.status()!==422)throw new Error('Crypto proxy did not reject unsupported path');
  if(await page.locator('.qsyn-homepage .terminal-sidebar').count())throw new Error('Homepage gained dashboard navigation');
  if(await page.locator('html').getAttribute('data-qsyn-theme')!=='light')throw new Error('First-visit light theme lost');
  // The /qsyn/terminal route retains existing chart compare, watchlist,
  // private-workspace and broker-safety behavior.
  await page.goto(origin+'/qsyn/terminal',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Trading charts'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('#qsyn-native-chart canvas').length>0,
    null,{timeout:12000});
  const source = await page.locator('.terminal-alert').innerText();
  if(!source.includes('Simulation workspace')||!source.includes('No live market data'))
    throw new Error('Missing unambiguous simulation provenance label');
  if(!(await page.locator('.terminal-nav-item.locked:disabled').count()===3))
    throw new Error('Broker-dependent navigation is not explicitly disabled');
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
  await page.getByRole('button',{name:'Dashboard',exact:true}).first().click();
  await page.getByRole('heading',{name:'Command center'}).waitFor();
  if(!page.url().includes('view=dashboard'))throw new Error('Dashboard deep link failed');
  if(!(await page.getByText('SIMULATION ONLY').count()))
    throw new Error('Dashboard simulation provenance label missing');
  await page.waitForFunction(()=>document.querySelectorAll('.qd-chart-preview #qsyn-native-chart canvas').length>0);
  if(!(await page.getByRole('heading',{name:'Synthetic premium workspace'}).count()))
    throw new Error('Dashboard lost chart preview');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Command center'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.qd-chart-preview #qsyn-native-chart canvas').length>0);
  await page.getByRole('button',{name:'Tools',exact:true}).first().click();
  await page.getByRole('heading',{name:'Tools'}).waitFor();
  if(!(await page.locator('a[href="/qsyn/studio"]').count()>0))
    throw new Error('Synthetic Studio link missing');
  // Public terminal stays browser-only without opt-in identity/private storage.
  await page.getByRole('button',{name:'Trading',exact:true}).first().click();
  await page.getByRole('heading',{name:'Trading charts'}).waitFor();
  if(await page.getByRole('button',{name:'Load private file'}).count()!==0)
    throw new Error('Private workspace controls unexpectedly available without authentication');

  // Stub an authenticated PRIVATE developer response in an isolated tab;
  // loading it must never copy owner-scoped layout data to the shared local key.
  const privatePage = await browser.newPage({viewport:{width:1280,height:800}});
  privatePage.on('pageerror',e=>browserErrors.push(e.message));
  const privateSnapshot = {
    schema:'QSYN-TERMINAL-BROWSER-WORKSPACES/1',
    watchlist:['QSYN-FINNIFTY-STRADDLE'],
    layouts:[{name:'Private unique',panes:[{id:'primary',symbol:'QSYN-FINNIFTY-STRADDLE'}],chartStates:{}}],
  };
  const requests=[];
  await privatePage.route('**/qsyn/api/v1/terminal/workspace', async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      const body=req.postDataJSON();requests.push(body);
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({mode:'simulated',storage:'private_file_development_only',
          revision:1,workspace:body.workspace})});
    } else {
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({mode:'simulated',storage:'private_file_development_only',
          revision:0,csrf:'a'.repeat(64),can_write:true,workspace:privateSnapshot})});
    }
  });
  await privatePage.goto(origin+'/qsyn/terminal',{waitUntil:'domcontentloaded'});
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
  const mobile=await browser.newPage({viewport:{width:390,height:844}});
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
  await mobile.getByRole('button',{name:'Trading',exact:true}).last().click();
  await mobile.getByRole('heading',{name:'Trading charts'}).waitFor();
  const oversized=await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);
  if(oversized)throw new Error('Terminal overflows on mobile');
  if(browserRequests.some(url=>/(\/api\/v1\/(placeorder|cancelorder|modifyorder)|\/auth\/login|\/socket\.io)/i.test(url)))
    throw new Error('Terminal unexpectedly requested broker, auth or order execution endpoints');
  if(browserErrors.length)throw new Error('Browser exceptions: '+JSON.stringify(browserErrors));
  console.log('PASS: full-viewport OpenAlgo-only homepage, legacy rollback, terminal, mobile, CSP and no order calls');
}finally{
  if(browser)await browser.close();
  if(server)server.kill('SIGTERM');
  for(const ext of ['js','css'])await rm(resolve(assets,'terminal.'+ext),{force:true});
}

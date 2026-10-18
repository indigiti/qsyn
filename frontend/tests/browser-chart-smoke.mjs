// Canonical React routing replaces the retired legacy chart and Rust admin
// documents. Admin APIs remain independently gated by server-side sessions.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,copyFile,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'../..');
const assets=resolve(root,'apps/web-php/public/assets');
let server,browser;
async function port(){
  const s=createServer();await new Promise((ok,fail)=>s.once('error',fail).listen(0,'127.0.0.1',ok));
  const p=s.address().port;await new Promise(ok=>s.close(ok));return p;
}
try{
  await mkdir(assets,{recursive:true});
  for(const ext of ['js','css'])
    await copyFile(resolve(root,'frontend/dist/terminal.'+ext),resolve(assets,'terminal.'+ext));
  const p=await port(),origin='http://127.0.0.1:'+p;
  const adminPassword='ci-terminal-chart-admin-password-123456';
  const adminHash=execFileSync('php',['-r','echo password_hash($argv[1], PASSWORD_DEFAULT);',adminPassword],{encoding:'utf8'}).trim();
  server=spawn('php',['-S','127.0.0.1:'+p,'-t','apps/web-php/public','apps/web-php/dev-router.php'],
    {cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,QSYN_ALLOW_HTTP_TEST:'1',QSYN_CONTROL_ENABLED:'1',QSYN_ADMIN_PASSWORD_HASH:adminHash}});
  for(let n=0;n<60;n++){
    try{if((await fetch(origin+'/qsyn/api/v1/health')).ok)break;}
    catch{}await delay(150);
  }
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Anonymous legacy URLs must NOT serve React or redirect into unlocked workspaces.
  for(const old of ['/qsyn/admin/rust','/qsyn/legacy-chart']){
    const blocked=await page.request.get(origin+old,{maxRedirects:0});
    if(blocked.status()!==303||blocked.headers().location!=='/qsyn/terminal/login')
      throw Error('Legacy alias not admin-gated: '+old);
  }
  await page.goto(origin+'/qsyn/admin/rust',{waitUntil:'domcontentloaded'});
  await page.getByLabel('QSYN administrator password').fill(adminPassword);
  await page.getByRole('button',{name:'Unlock terminal'}).click();
  if(new URL(page.url()).pathname==='/qsyn/terminal/login')
    throw new Error('Administrator unlock returned login instead of terminal: '+(await page.locator('body').innerText()).slice(0,420));
  await page.getByRole('heading',{name:'Dashboard'}).waitFor();
  const checks=[
    ['/qsyn/admin/rust','operations','Service administration'],
    ['/qsyn/admin/rust/','operations','Service administration'],
    ['/qsyn/legacy-chart','diagnostics','Diagnostics & feed health'],
    ['/qsyn/legacy-chart/','diagnostics','Diagnostics & feed health'],
  ];
  for(const [old,view,heading] of checks){
    const res=await page.request.get(origin+old,{maxRedirects:0});
    if(res.status()!==302||res.headers().location!=='/qsyn/terminal/'+view||
      !String(res.headers()['cache-control']||'').includes('no-store'))
      throw Error('Retired URL leaked old HTML: '+old+' '+res.status());
    const destination=await page.goto(origin+old,{waitUntil:'domcontentloaded',timeout:25000});
    if(destination.status()!==200||!page.url().endsWith('/qsyn/terminal/'+view))
      throw Error('Retired URL escaped React terminal: '+old);
    await page.getByRole('heading',{name:heading,exact:true}).waitFor({timeout:15000});
    if(await page.locator('iframe').count())throw Error('Embedded old dashboard iframe');
  }
  // Direct PHP entrypoints cannot be used as bypass URLs.
  // The PHP -S test router rewrites direct documents through index.php.
  // Inspect the physical fallback shim independently for Cloudways deployments.
  const shim=await readFile(resolve(root,'apps/web-php/public/admin-rust.php'),'utf8');
  if(!shim.includes("Location: /qsyn/terminal/operations") ||
      !shim.includes("no-store") || shim.includes('<!doctype html>'))
    throw Error('Physical admin-rust.php was not retired');
  const unauth=await browser.newPage();
  const state=await unauth.request.get(origin+'/qsyn/api/v1/admin/rust/state');
  if(state.status()!==200||(await state.json()).authenticated!==false)
    throw Error('Administrator endpoint unexpectedly authenticated');
  const denied=await unauth.request.post(origin+'/qsyn/api/v1/admin/rust/action',{
    data:{action:'restart'},headers:{'Content-Type':'application/json'}});
  if(denied.status()===200)throw Error('Unauthenticated service restart authorized');
  await unauth.close();
  await page.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelectorAll('.qsyn-home-chart canvas').length>0,
    null,{timeout:16000});
  if(await page.locator('.terminal-sidebar').count())throw Error('Homepage acquired sidebar');
  // The homepage must display the same account-private Rust candles as the
  // authenticated Markets chart, without redirecting to obsolete worker plans.
  const sessionDay='2026-10-09';
  let personalHistoryCalls=0,proofRequests=0;
  const requestedHistoryDays=new Set();
  const browserRequests=[];
  page.on('request',req=>{
    if(req.url().includes('upstox'))browserRequests.push(req.method()+' '+req.url().split('/api/')[1]);
  });
  await page.route('**/qsyn/api/v1/admin/upstox/index-history-proof',route=>{
    proofRequests++;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      schema:'QSYN-INDEX-HISTORICAL-PROOF/1',token_present:true,
      csrf:'a'.repeat(64),suggested_day_ist:sessionDay,trading_enabled:false
    })});
  });
  await page.route('**/qsyn/api/v1/admin/upstox/personal-index/history',async route=>{
    personalHistoryCalls++;
    const body=route.request().postDataJSON();
    requestedHistoryDays.add(body.day);
    if(route.request().method()!=='POST'||
       route.request().headers()['x-csrf-token']!=='a'.repeat(64)||
       body.symbol!=='NIFTY')throw Error('Homepage used an unscoped index request');
    const open=Math.floor(Date.parse(body.day+'T09:15:00+05:30')/1000);
    const bars=Array.from({length:375},(_,i)=>({
      time:open+i*60,open:25000+i/10,high:25003+i/10,
      low:24998+i/10,close:25001+i/10,volume:0
    }));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      schema:'QSYN-UPSTOX-RUST-INDEX-HISTORY/1',
      source:'upstox_v3_rust_history',symbol:'NIFTY',
      day_ist:body.day,interval:'1m',bars,
      public_redistribution_allowed:false,trading_enabled:false
    })});
  });
  await page.evaluate(()=>localStorage.setItem('qsyn-public-chart-selection-v1',JSON.stringify({
    schema:'QSYN-PUBLIC-CHART-SELECTION/1',exchange:'NSE_INDEX:index',symbol:'NIFTY'
  })));
  await page.reload({waitUntil:'domcontentloaded'});
  try {
    await page.waitForFunction(()=>document.querySelector('.qsyn-screenreader-status')?.textContent
      ?.includes('750 real Rust Upstox 1m candles'),null,{timeout:18000});
  } catch(e) {
    const diag=await page.evaluate(()=>({
      status:document.querySelector('.qsyn-screenreader-status')?.textContent,
      blocked:document.querySelector('.qsyn-india-entitlement-note')?.textContent,
      symbol:document.querySelector('input')?.value,
      selection:localStorage.getItem('qsyn-public-chart-selection-v1'),
      grids:document.querySelectorAll('.qsyn-home-chart canvas').length
    }));
    throw Error('Homepage Rust chart browser fixture failed '+JSON.stringify({
      diag,proofRequests,personalHistoryCalls,browserRequests:browserRequests.slice(-12),
      errors:errors.slice(-6),cause:String(e)
    }));
  }
  if(personalHistoryCalls<2 || requestedHistoryDays.size<2)
    throw Error('Homepage did not automatically load the preceding NIFTY trading session');
  if(await page.locator('.qsyn-india-entitlement-note').count())
    throw Error('Authenticated homepage still displayed obsolete index-plan blocker');
  if(await page.locator('.qsyn-home-chart canvas').count()===0)
    throw Error('Authenticated NIFTY homepage did not render candles');
  await page.unroute('**/qsyn/api/v1/admin/upstox/index-history-proof');
  await page.unroute('**/qsyn/api/v1/admin/upstox/personal-index/history');

  // Anonymous homepage must still fail closed and NEVER probe private Rust
  // history. Public crypto remains available to non-admin visitors.
  const anonymous=await browser.newContext({viewport:{width:900,height:600}});
  const anonPage=await anonymous.newPage();
  let anonymousHistory=0;
  await anonPage.route('**/qsyn/api/v1/admin/upstox/personal-index/history',route=>{
    anonymousHistory++;return route.abort();
  });
  await anonPage.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded'});
  await anonPage.evaluate(()=>localStorage.setItem('qsyn-public-chart-selection-v1',JSON.stringify({
    schema:'QSYN-PUBLIC-CHART-SELECTION/1',exchange:'BSE_INDEX:index',symbol:'SENSEX'
  })));
  await anonPage.reload({waitUntil:'domcontentloaded'});
  // Anonymous users see source availability, not an administrator login CTA.
  await anonPage.getByText('Index source unavailable',{exact:true}).waitFor({timeout:20000});
  if(await anonPage.getByText('Sign in to QSYN').count()!==0)
    throw Error('Homepage index selection must not require QSYN administrator login');
  if(anonymousHistory!==0)throw Error('Anonymous NSE/BSE private history exposed');
  await anonymous.close();
  if(errors.length)throw Error('Browser script errors: '+errors.join('; ').slice(0,450));
  console.log('PASS: retired Rust admin + legacy chart redirect into React; unauthenticated controls blocked; homepage unchanged');
}finally{
  await browser?.close();
  server?.kill('SIGTERM');
  for(const ext of ['js','css'])await rm(resolve(assets,'terminal.'+ext),{force:true});
}

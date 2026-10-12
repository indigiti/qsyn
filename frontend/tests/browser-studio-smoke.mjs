// Unified React strategy regression: no independent /qsyn/studio HTML.
// All prices here remain simulated and order execution is disabled.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,copyFile,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),assets=resolve(root,'apps/web-php/public/assets');
let php,browser;
const freePort=async()=>{
  const s=createServer();await new Promise((ok,fail)=>s.once('error',fail).listen(0,'127.0.0.1',ok));
  const p=s.address().port;await new Promise(ok=>s.close(ok));return p;
};
try{
  await mkdir(assets,{recursive:true});
  for(const ext of ['js','css'])
    await copyFile(resolve(root,'frontend/dist/terminal.'+ext),resolve(assets,'terminal.'+ext));
  const port=await freePort(),origin='http://127.0.0.1:'+port;
  const adminPassword='ci-terminal-studio-admin-password-123456';
  const adminHash=execFileSync('php',['-r','echo password_hash($argv[1], PASSWORD_DEFAULT);',adminPassword],{encoding:'utf8'}).trim();
  php=spawn('php',['-S','127.0.0.1:'+port,'-t','apps/web-php/public','apps/web-php/dev-router.php'],
    {cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,QSYN_ALLOW_HTTP_TEST:'1',QSYN_CONTROL_ENABLED:'1',QSYN_ADMIN_PASSWORD_HASH:adminHash,
      QSYN_IDENTITY_ENABLED:'0',QSYN_MOCK_ACCOUNTS_ENABLED:'0'}});
  for(let i=0;i<60;i++){
    try{if((await fetch(origin+'/qsyn/api/v1/health')).ok)break;}catch{}
    await delay(130);
  }
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[],orders=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/\/api\/v1\/(placeorder|modifyorder|cancelorder)/.test(r.url()))orders.push(r.url());});
  for(const path of ['/qsyn/studio','/qsyn/studio/']){
    const blocked=await page.request.get(origin+path,{maxRedirects:0});
    if(blocked.status()!==303 || blocked.headers().location!=='/qsyn/terminal/login')
      throw Error('Anonymous Studio bypassed admin sign-in');
  }
  await page.goto(origin+'/qsyn/studio/',{waitUntil:'domcontentloaded'});
  await page.getByLabel('QSYN administrator password').fill(adminPassword);
  await page.getByRole('button',{name:'Unlock terminal'}).click();
  if(new URL(page.url()).pathname==='/qsyn/terminal/login')
    throw new Error('Administrator unlock returned login instead of terminal: '+(await page.locator('body').innerText()).slice(0,420));
  await page.getByRole('heading',{name:'Market explorer'}).waitFor();
  for(const path of ['/qsyn/studio','/qsyn/studio/']){
    const res=await page.request.get(origin+path,{maxRedirects:0});
    if(res.status()!==302||res.headers().location!=='/qsyn/terminal/strategy'||
      !String(res.headers()['cache-control']||'').includes('no-store'))
      throw Error('Retired strategy URL still serves HTML: '+path);
    const post=await page.request.post(origin+path,{maxRedirects:0});
    if(post.status()!==405)throw Error('Retired strategy accepted POST: '+path);
  }
  // The PHP -S test router rewrites direct documents through index.php.
  // Inspect the physical fallback shim independently for Cloudways deployments.
  const shim=await readFile(resolve(root,'apps/web-php/public/studio.php'),'utf8');
  if(!shim.includes("Location: /qsyn/terminal/strategy") ||
      !shim.includes("no-store") || shim.includes('<!doctype html>'))
    throw Error('Physical studio.php was not retired');
  const r=await page.goto(origin+'/qsyn/studio/',{waitUntil:'domcontentloaded'});
  if(r.status()!==200||!page.url().endsWith('/qsyn/terminal/strategy'))
    throw Error('Studio does not resolve to unified React strategy workspace');
  await page.getByRole('heading',{name:'Strategy Studio'}).waitFor({timeout:14000});
  await page.waitForFunction(()=>document.querySelectorAll('.qt-table tbody tr').length===13,
    null,{timeout:12000});
  if(await page.locator('.qt-leg').count()!==2)throw Error('Default strategy legs missing');
  await page.getByRole('button',{name:'Render strategy'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.qt-strategy-canvas canvas').length>0,
    null,{timeout:15000});
  const market=await page.request.get(origin+'/qsyn/api/v1/studio/market?underlying=NIFTY');
  if(market.status()!==200)throw Error('Existing simulation market API unavailable');
  const m=await market.json();
  if(m.mode!=='simulated'||m.trading_enabled!==false||m.broker_connected!==false)
    throw Error('Strategy API breached simulation provenance');
  const text=await page.locator('#terminal-main').innerText();
  if(!text.includes('Hypothetical')&&!text.includes('hypothetical'))
    throw Error('Payoff simulation disclaimer removed');
  await page.getByRole('button',{name:'Add leg'}).click();
  if(await page.locator('.qt-leg').count()!==3)throw Error('Third simulated leg missing');
  await page.getByRole('textbox',{name:'Strategy template name'}).fill('Archived research');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  if(!(await page.evaluate(()=>localStorage.getItem('qsyn-unified-strategies-v1')||'')).includes('Archived research'))
    throw Error('Browser-local strategy template missing');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Strategy Studio'}).waitFor();
  await page.getByRole('combobox',{name:'Saved strategy templates'}).selectOption('Archived research');
  await page.waitForFunction(()=>document.querySelectorAll('.qt-leg').length===3,null,{timeout:12000});
  if(errors.length)throw Error('React errors: '+errors.join('; ').slice(0,400));
  if(orders.length)throw Error('Broker order endpoint called: '+orders[0]);
  console.log('PASS: retired Studio redirected; React strategy, option chain, payoff, local templates and simulation gates verified');
}finally{
  await browser?.close();
  php?.kill('SIGTERM');
  for(const ext of ['js','css'])await rm(resolve(assets,'terminal.'+ext),{force:true});
}

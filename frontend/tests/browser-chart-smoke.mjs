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
  page.on('request',req=>{if(req.method()==='POST'&&req.url().includes('/qsyn/terminal/login')){
    const h=req.headers();console.log('TEST LOGIN REQUEST metadata',JSON.stringify({origin:h.origin||null,fetchSite:h['sec-fetch-site']||null,host:h.host||null}));
  }});
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
  await page.getByRole('heading',{name:'Trading charts'}).waitFor();
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
  if(errors.length)throw Error('Browser script errors: '+errors.join('; ').slice(0,450));
  console.log('PASS: retired Rust admin + legacy chart redirect into React; unauthenticated controls blocked; homepage unchanged');
}finally{
  await browser?.close();
  server?.kill('SIGTERM');
  for(const ext of ['js','css'])await rm(resolve(assets,'terminal.'+ext),{force:true});
}

/* Read-only remote browser acceptance for QSYN #246.
 * Never submit credentials or admin service actions.
 * No production data writes. */
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
const host='https://stage.digiti.in';
const failures=[];
const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
page.on('pageerror',e=>failures.push('BROWSER_EXCEPTION '+e.message));
async function step(label,fn){
 try {const detail=await fn(); console.log('PASS '+label+(detail?' '+detail:''));}
 catch(e){failures.push(label+': '+String(e).slice(0,300));console.error('FAIL '+label+': '+String(e).slice(0,300));}
}
async function navigate(path,heading){
 const r=await page.goto(host+path,{waitUntil:'domcontentloaded',timeout:30000});
 if(r?.status()!==200)throw Error('status='+r?.status());
 if(heading)await page.getByRole('heading',{name:heading,exact:true}).waitFor({timeout:16000});
}
await mkdir('artifacts',{recursive:true});
await step('Homepage remains a chart-only experience',async()=>{
 await navigate('/qsyn/');
 await page.locator('.qsyn-home-chart .oac-sym input').first().waitFor({timeout:18000});
 await page.waitForFunction(()=>document.querySelectorAll('.qsyn-home-chart canvas').length>0,null,{timeout:16000});
 if(await page.locator('.terminal-sidebar, .terminal-topbar, .qd-dashboard').count()>0)
   throw Error('Unified terminal controls leaked onto homepage');
 await page.screenshot({path:'artifacts/qsyn-246-homepage.png',fullPage:false});
 return 'canvas present; no sidebar';
});
await step('React terminal market charts render',async()=>{
 await navigate('/qsyn/terminal?view=markets','Live crypto & India index charts');
 await page.waitForFunction(()=>document.querySelectorAll('.terminal-market-embedded canvas').length>0,null,{timeout:17000});
 if(await page.locator('iframe').count()>0)throw Error('embedded legacy iframe');
 await page.screenshot({path:'artifacts/qsyn-246-market-terminal.png',fullPage:false});
 return 'native chart rendered inside terminal';
});
await step('React feed diagnostics list all seven venues',async()=>{
 await navigate('/qsyn/terminal?view=diagnostics','Diagnostics & feed health');
 await page.locator('.qt-table tbody tr').first().waitFor({timeout:16000});
 const count=await page.locator('.qt-table tbody tr').count();
 if(count!==7)throw Error('expected seven rows, found '+count);
 await page.screenshot({path:'artifacts/qsyn-246-diagnostics.png',fullPage:false});
 return count+' venues';
});
await step('Broker workspace requires authorization',async()=>{
 await navigate('/qsyn/terminal?view=brokers','Accounts & authorizations');
 await page.getByText('No production broker session verified',{exact:true}).waitFor({timeout:15000});
 const text=await page.locator('#terminal-main').innerText();
 if(!text.includes('Order execution')||!text.includes('Disabled'))
   throw Error('trading-disabled notice missing');
 return 'no production broker inferred';
});
await step('Rust operations remain unauthorized without admin login',async()=>{
 await navigate('/qsyn/terminal?view=operations','Service administration');
 // If already authorized somehow, clean browser context contains no cookies, so
 // never click admin controls; record a failure for investigation.
 const r=await page.request.get(host+'/qsyn/api/v1/admin/rust/state');
 if(r.status()!==200)throw Error('admin state '+r.status());
 const state=await r.json();
 if(state.authenticated===true)throw Error('anonymous client unexpectedly authenticated');
 if(await page.getByRole('button',{name:'Restart',exact:true}).count()>0 &&
    await page.getByRole('button',{name:'Restart',exact:true}).isEnabled())
   throw Error('anonymous Rust restart enabled');
 return 'session gated';
});
await step('Native React Strategy Studio loads and renders demo chart',async()=>{
 await navigate('/qsyn/terminal?view=strategy','Strategy Studio');
 const render=page.getByRole('button',{name:'Render strategy'});
 await render.waitFor({timeout:16000});
 await render.click();
 await page.waitForFunction(()=>document.querySelectorAll('.qt-strategy-canvas canvas').length>0,null,{timeout:18000});
 const prose=await page.locator('#terminal-main').innerText();
 if(!prose.includes('hypothetical')&&!prose.includes('Hypothetical'))
   throw Error('simulated payoff provenance missing');
 await page.screenshot({path:'artifacts/qsyn-246-strategy.png',fullPage:false});
 return 'simulation-only';
});
await step('India index gate rejects unlicensed market data',async()=>{
 const r=await page.request.get(host+'/qsyn/api/v1/india/bars?exchange=NSE_INDEX&symbol=NIFTY&interval=1m&limit=5');
 if(r.status()!==503)throw Error('expected 503, got '+r.status());
 const j=await r.json();
 if(j.error!=='india_index_feed_not_authorized')throw Error('wrong license gate');
 return '503 denied as designed';
});
await step('Binance health endpoint remains operational',async()=>{
 const p='exchange=BINANCE&market=spot&symbol=BTCUSDT&interval=1m&limit=5';
 const r=await page.request.get(host+'/qsyn/api/v1/crypto/health?'+p);
 if(r.status()!==200)throw Error('status '+r.status());
 const j=await r.json();
 if(j.schema!=='QSYN-PUBLIC-CRYPTO-HEALTH/1')throw Error('invalid crypto schema');
 return 'feed state='+j.feed?.state+', fresh='+j.feed?.fresh;
});
await page.close();
await browser.close();
console.log('ACCEPTANCE_SUMMARY',JSON.stringify({tested:8,passed:8-failures.length,failures},null,2));
if(failures.length)process.exitCode=1;
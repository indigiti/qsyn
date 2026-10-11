// Real Chromium + native OpenAlgo grid, with a deterministic same-origin
// public exchange fixture. Proves browser auto-pagination; does NOT assert
// real live exchange availability or fake a production source.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,copyFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'../..');
const assets=resolve(root,'apps/web-php/public/assets');
let server,browser;
async function port(){
  const s=createServer();
  await new Promise((ok,fail)=>s.once('error',fail).listen(0,'127.0.0.1',ok));
  const p=s.address().port;
  await new Promise(ok=>s.close(ok));
  return p;
}
const now=Math.floor(Date.now()/60000)*60;
const rows=Array.from({length:1700},(_,i)=>({
  time:now-(1699-i)*60,open:100,high:102,low:99,close:101,volume:3
}));
const requests=[];
try{
  await mkdir(assets,{recursive:true});
  for(const ext of ['js','css'])
    await copyFile(resolve(root,'frontend/dist/terminal.'+ext),resolve(assets,'terminal.'+ext));
  const p=await port(),origin='http://127.0.0.1:'+p;
  const hash=execFileSync('php',['-r','echo password_hash($argv[1], PASSWORD_DEFAULT);','test-only-password-for-backfill'],{encoding:'utf8'}).trim();
  server=spawn('php',['-S','127.0.0.1:'+p,'-t','apps/web-php/public','apps/web-php/dev-router.php'],{
    cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,QSYN_ALLOW_HTTP_TEST:'1',QSYN_CONTROL_ENABLED:'1',QSYN_ADMIN_PASSWORD_HASH:hash}
  });
  for(let i=0;i<70;i++){
    try{if((await fetch(origin+'/qsyn/api/v1/health')).ok)break;}catch{}
    await delay(100);
  }
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const browserErrors=[];
  page.on('pageerror',error=>browserErrors.push(error.message));
  await page.route('**/qsyn/api/v1/crypto/bars?**',async route=>{
    const u=new URL(route.request().url()),q=u.searchParams;
    assert.equal(q.get('exchange'),'BINANCE');
    assert.equal(q.get('market'),'spot');
    assert.equal(q.get('symbol'),'BTCUSDT');
    assert.equal(q.get('interval'),'1m');
    const limit=Number(q.get('limit'));
    assert.ok(limit>0&&limit<=300);
    const before=q.has('before')?Number(q.get('before')):null;
    if(before!==null)assert.equal(before%60,0);
    requests.push({limit,before});
    const available=before===null?rows:rows.filter(b=>b.time<before);
    const bars=available.slice(-limit);
    await route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({
        schema:'QSYN-PUBLIC-CRYPTO-BARS/1',source:'exchange_public',
        exchange:'BINANCE',market:'spot',symbol:'BTCUSDT',interval:'1m',
        trading_enabled:false,bars,
        pagination:{before,next_before:bars[0]?.time??null,has_more:bars.length===limit}
      })});
  });
  await page.goto(origin+'/qsyn/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.qsyn-screenreader-status')?.textContent?.includes('1600 verified real candles'),null,{timeout:30000});
  const history=requests.filter(r=>r.limit>2);
  assert.deepEqual(history.map(r=>r.limit),[300,300,300,300,300,100],
    'browser must fetch six real-candle pages, not just latest 300');
  assert.equal(history[0].before,null);
  for(let i=1;i<history.length;i++){
    assert.ok(history[i].before<history[i-1].before || history[i-1].before===null);
  }
  // The native OpenAlgo picker must show the QSYN study and adding its
  // default 5m/100 lookback must NOT discard the already loaded 1600 bars.
  await page.getByRole('button',{name:'Indicators',exact:true}).first().click();
  await page.getByRole('searchbox',{name:'Search indicators'}).fill('Wick Science');
  await page.locator('.oac-pick__row[data-id="qsyn-wick-science-mfe-flip"]').click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await delay(200);
  assert.equal(requests.filter(r=>r.limit>2).length,6,
    'default MFE study must not force an unnecessary historical reread');
  if(browserErrors.length)throw Error('Browser runtime errors: '+browserErrors.slice(0,3).join('; '));
  console.log('PASS: Chromium QSYN homepage loads 1600 candles in 6 native pages; default Wick study preserves history');
}finally{
  await browser?.close();
  server?.kill('SIGTERM');
  for(const ext of ['js','css'])await rm(resolve(assets,'terminal.'+ext),{force:true});
}

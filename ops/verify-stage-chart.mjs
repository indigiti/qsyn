#!/usr/bin/env node
/**
 * Real staging Chromium smoke. No mocked bars or administrative credentials.
 * Proves that the deployed native React/OpenAlgo chart automatically requests
 * the first 1600 public exchange candles; the companion CLI checks 15016.
 */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const base='https://stage.digiti.in/qsyn/';
const requests=[],errors=[];
let browser;
async function main(){
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>errors.push(String(error.message)));
  page.on('request',request=>{
    const u=new URL(request.url());
    if(u.hostname!=='stage.digiti.in'||u.pathname!=='/qsyn/api/v1/crypto/bars')return;
    const p=u.searchParams;
    if(p.get('exchange')!=='BINANCE'||p.get('market')!=='spot'||
       p.get('symbol')!=='BTCUSDT'||p.get('interval')!=='1m')return;
    const limit=Number(p.get('limit'));
    if(limit>2)requests.push({limit,before:p.has('before')?Number(p.get('before')):null});
  });
  const response=await page.goto(base,{waitUntil:'domcontentloaded',timeout:30000});
  assert.equal(response.status(),200,'staging homepage must respond 200');
  await page.waitForFunction(()=>{
    const s=document.querySelector('.qsyn-screenreader-status');
    return s&&s.textContent.includes('1600 verified real candles');
  },null,{timeout:150000});
  assert.ok(await page.locator('.qsyn-crypto-grid canvas').count()>0,'native chart must render');
  assert.equal(await page.locator('.terminal-sidebar').count(),0,'homepage remains chart-only');
  const initial=requests.slice();
  assert.deepEqual(initial.map(x=>x.limit),[300,300,300,300,300,100],
    'native chart must fetch 1600 candles in six provider-sized historical pages');
  assert.equal(initial[0].before,null);
  for(let i=1;i<initial.length;i++)
    assert.ok(Number.isSafeInteger(initial[i].before)&&
      (i===1||initial[i].before<initial[i-1].before),'historical cursor must move backwards');

  // Add the actual QSYN study through OpenAlgo's native picker. Default
  // 5m/100 needs only the existing 1600 bars; it must not cause a reread.
  await page.getByRole('button',{name:'Indicators',exact:true}).first().click();
  await page.getByRole('searchbox',{name:'Search indicators'}).fill('Wick Science');
  await page.locator('.oac-pick__row[data-id="qsyn-wick-science-mfe-flip"]').click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.waitForTimeout(500);
  assert.equal(requests.length,6,'default Wick Science study must preserve already loaded history');
  assert.deepEqual(errors,[],'no uncaught browser script errors');
  const report={
    schema:'QSYN-STAGE-CHART-ACCEPTANCE/1',status:'pass',
    deployment_page:base,chart:'OpenAlgo native grid',symbol:'BINANCE:spot:BTCUSDT',
    interval:'1m',initial_history_bars:1600,history_requests:requests,
    wick_science:'native study added without discarding existing history',
    browser_errors:0
  };
  console.log(JSON.stringify(report,null,2));
  await writeFile('stage-chart-report.json',JSON.stringify(report,null,2));
}
try{await main();}
catch(error){
  const report={schema:'QSYN-STAGE-CHART-ACCEPTANCE/1',status:'fail',
    code:'STAGE_CHART_NOT_VERIFIED',message:String(error.message||error).slice(0,380),
    requests_seen:requests,browser_errors:errors.slice(0,4)};
  console.error(JSON.stringify(report,null,2));
  await writeFile('stage-chart-report.json',JSON.stringify(report,null,2));
  process.exitCode=1;
}finally{await browser?.close();}

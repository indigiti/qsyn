#!/usr/bin/env node
/**
 * QSYN public crypto stage acceptance. Read-only; no broker credentials,
 * admin sessions, trading endpoints, persistence or simulated data.
 * Node >=20. Usage: node ops/verify-public-backfill.mjs --base
 * https://stage.digiti.in/qsyn --bars 1600 (or 15016).
 */
import {pathToFileURL} from 'node:url';

const SCHEMA='QSYN-PUBLIC-CRYPTO-BARS/1';
const INTERVAL=60;
const MAX_BARS=15016;
const PAGE_SIZE=300;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const failure=(code,message)=>Object.assign(new Error(message),{code});

function checkBar(row,prev,upperBound){
  if(!row||!Number.isSafeInteger(row.time)||row.time%INTERVAL!==0||row.time<=0||
     (upperBound!==null&&row.time>=upperBound)||
     !['open','high','low','close','volume'].every(k=>typeof row[k]==='number'&&Number.isFinite(row[k]))||
     row.open<=0||row.high<=0||row.low<=0||row.close<=0||row.volume<0||
     row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close))
    throw failure('INVALID_BAR','Invalid or out-of-cursor exchange OHLCV candle');
  if(prev!==null&&row.time!==prev+INTERVAL)
    throw failure('GAP_OR_DUPLICATE','Expected contiguous, strictly increasing 60-second OHLCV timestamps');
}

export async function verifyPublicBackfill({
  base='https://stage.digiti.in/qsyn', bars=1600, fetchFn=globalThis.fetch,
  nowFn=Date.now, maxFreshnessSeconds=300, pageTimeoutMs=20000,
  overallTimeoutMs=300000, sleep=pause,
}={}){
  if(!Number.isSafeInteger(bars)||bars<1||bars>MAX_BARS)
    throw failure('INVALID_TARGET','Target must be between 1 and 15016 candles');
  const origin=new URL(base);
  if(origin.protocol!=='https:'&&origin.hostname!=='127.0.0.1'&&origin.hostname!=='localhost')
    throw failure('INVALID_TARGET','Non-local stage probes must use HTTPS');
  const basePath=origin.pathname.replace(/\/+$/,'');
  const started=nowFn(), deadline=started+overallTimeoutMs;
  let before=null, latest=null, oldest=null, previousFirst=null, count=0;
  const pages=[];
  while(count<bars){
    const limit=Math.min(PAGE_SIZE,bars-count);
    const endpoint=new URL(basePath+'/api/v1/crypto/bars',origin);
    for(const [k,v] of Object.entries({exchange:'BINANCE',market:'spot',symbol:'BTCUSDT',interval:'1m',limit:String(limit)}))
      endpoint.searchParams.set(k,v);
    if(before!==null)endpoint.searchParams.set('before',String(before));
    let body;
    for(let attempt=0;attempt<3;attempt++){
      const remain=deadline-nowFn();
      if(remain<=0)throw failure('DEADLINE_EXCEEDED','History validation exceeded total deadline');
      let response;
      try{
        response=await fetchFn(endpoint,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(Math.min(remain,pageTimeoutMs))});
      }catch(error){
        throw failure('REQUEST_FAILED','Public candle request failed: '+String(error?.message||error));
      }
      if((response.status===429||response.status===503)&&attempt<2){
        await sleep(1000*(attempt+1));
        continue;
      }
      if(!response.ok)throw failure('HTTP_ERROR','Public candle API returned HTTP '+response.status);
      try{body=await response.json();}catch{throw failure('NON_JSON','Expected a JSON candle response');}
      break;
    }
    if(body?.schema!==SCHEMA||body.source!=='exchange_public'||body.exchange!=='BINANCE'||
      body.market!=='spot'||body.symbol!=='BTCUSDT'||body.interval!=='1m'||
      body.trading_enabled!==false||!body.pagination||
      body.pagination.before!==before||typeof body.pagination.has_more!=='boolean'||
      !Array.isArray(body.bars)||body.bars.length>limit)
      throw failure('INVALID_PROVENANCE','Invalid public-history schema, provenance or page metadata');
    const rows=body.bars;
    if(!rows.length)throw failure('HISTORY_EXHAUSTED','No more bars before target was reached');
    for(let i=0;i<rows.length;i++)checkBar(rows[i],i>0?rows[i-1].time:null,before);
    const first=rows[0].time,last=rows.at(-1).time;
    if(body.pagination.next_before!==first)
      throw failure('INVALID_CURSOR','next_before does not equal first candle timestamp');
    if(previousFirst!==null && last!==previousFirst-INTERVAL)
      throw failure('PAGE_BOUNDARY_GAP','Adjacent history pages do not join on one-minute boundary');
    if(latest===null){
      latest=last;
      const freshnessSec=Math.floor(nowFn()/1000)-last;
      if(freshnessSec>maxFreshnessSeconds||freshnessSec< -INTERVAL)
        throw failure('STALE_LATEST','Latest public crypto candle not fresh: age '+freshnessSec+' seconds');
    }
    oldest=first;
    pages.push({index:pages.length+1,candles:rows.length,first,last,before});
    count+=rows.length;
    previousFirst=first;
    before=first;
    if(count<bars&&!body.pagination.has_more)
      throw failure('HISTORY_EXHAUSTED','Server ended pagination at '+count+' of '+bars+' requested candles');
    if(pages.length>Math.ceil(MAX_BARS/PAGE_SIZE)+2)
      throw failure('PAGE_LIMIT','Exceeded bounded public-history page allowance');
  }
  return {
    schema:'QSYN-STAGE-HISTORICAL-ACCEPTANCE/1', status:'pass',
    symbol:'BINANCE:spot:BTCUSDT', interval:'1m',
    target_bars:bars,verified_bars:count,page_count:pages.length,
    first_candle_utc:new Date(oldest*1000).toISOString(),
    last_candle_utc:new Date(latest*1000).toISOString(),
    missing_minutes:0,duplicates:0,invalid_ohlcv:0,
    duration_ms:nowFn()-started, pages,
  };
}

async function main(){
  const args=process.argv.slice(2),opt={};
  for(let i=0;i<args.length;i+=2){
    if(!['--base','--bars'].includes(args[i])||!args[i+1])
      throw failure('INVALID_CLI','Usage: --base https://stage.digiti.in/qsyn --bars 1600|15016');
    opt[args[i]==='--base'?'base':'bars']=args[i]==='--bars'?Number(args[i+1]):args[i+1];
  }
  try{console.log(JSON.stringify(await verifyPublicBackfill(opt),null,2));}
  catch(error){
    console.error(JSON.stringify({schema:'QSYN-STAGE-HISTORICAL-ACCEPTANCE/1',status:'fail',
      code:error.code||'INTERNAL_ERROR',message:String(error.message).slice(0,300)}));
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  await main();

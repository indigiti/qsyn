import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePrivateChartScope, fetchPrivateChartGrant, PrivateAuthorizedChartFeed,
} from '../src/private-live-chart.js';

const csrf = 'a'.repeat(64);
const account = 'approved-upstox-A';
const instrument = 'NSE_FO|12345';
const ticket = 'e30.c2lnbmF0dXJl';

test('private chart strictly accepts Upstox FO keys, never arbitrary brokerage symbols', () => {
  assert.equal(validatePrivateChartScope(account, instrument), true);
  assert.equal(validatePrivateChartScope('other.com/steal', instrument), false);
  assert.equal(validatePrivateChartScope(account, 'NFO|ALIAS'), false);
  assert.equal(validatePrivateChartScope(account, 'NSE_FO|abc'), false);
});

test('grant cannot be fetched without authenticated private test identity', async () => {
  await assert.rejects(fetchPrivateChartGrant(async () => ({
    ok: true, json: async () => ({authenticated:false,csrf,profile:'mock-only'}),
  }),account,instrument), /Private test login required/);
  await assert.rejects(fetchPrivateChartGrant(async () => ({
    ok:false, status:503,
  }),account,instrument), /not configured/);
});

test('grant matches server scope and never trusts a WSS endpoint from response', async () => {
  const requests=[];
  const fetcher = async (path, options) => {
    requests.push({path,options});
    if (path.includes('/auth/state')) return {ok:true,json:async()=>({
      authenticated:true,csrf,profile:'mock-only'})};
    return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',
      account_id:account, instrument,transport:'operator_private_wss_only',
      trading_enabled:false,public_redistribution_allowed:false,
      ticket,expires_ms:Date.now()+20_000,
      url:'wss://attacker.test/never-follow',
    })};
  };
  const grant = await fetchPrivateChartGrant(fetcher,account,instrument);
  assert.equal(grant.ticket,ticket);
  assert.equal(requests[1].path,'/qsyn/api/v1/terminal/private-chart-grant');
  assert.equal(requests[1].options.credentials,'same-origin');
  assert.equal(requests[1].options.headers['X-CSRF-Token'],csrf);
  assert.deepEqual(JSON.parse(requests[1].options.body),
    {account_id:account,instrument});
  assert.equal(requests.some(r=>r.path.includes('attacker')),false);
});

test('private history never borrows simulated chart data', async () => {
  const feed = new PrivateAuthorizedChartFeed(account,instrument,()=>{},{
    fetcher:async()=>{throw Error('must not request public history');},
    socketFactory:()=>{throw Error('must not connect yet');},
    location:{protocol:'https:',host:'qsyn.example'},
  });
  assert.deepEqual(await feed.getBars({
    symbol:instrument,exchange:'UPSTOX_PRIVATE',interval:'1m'
  }),[]);
  assert.deepEqual(await feed.getBars({
    symbol:'QSYN-DEMO',exchange:'QSYN',interval:'1m'
  }),[]);
  feed.destroy();
});


test('authorized leg history loads with short-lived token and does not call simulated APIs', async () => {
  const calls=[];
  const dateTime = Math.floor(Date.now()/60000)*60 - 86400;
  const bars=[{ time:dateTime,open:100,high:103,low:99,close:102 }];
  const fetcher=async (path,options)=>{
    calls.push({path,options});
    if(path==='/qsyn/api/v1/auth/state') return {ok:true,json:async()=>({
      authenticated:true,csrf,profile:'mock-only'})};
    if(path==='/qsyn/api/v1/terminal/private-chart-grant') return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',account_id:account,
      instrument,transport:'operator_private_wss_only',trading_enabled:false,
      public_redistribution_allowed:false,ticket,expires_ms:Date.now()+20_000
    })};
    if(path==='/qsyn/private-chart/history') return {ok:true,json:async()=>({
      schema:'QSYN-UPSTOX-PRIVATE-HISTORY/1',source:'licensed_private_history',
      account,instrument,exchange:'UPSTOX_PRIVATE',interval:'1m',
      trading_enabled:false,public_redistribution_allowed:false,
      history_complete:false,bars,
    })};
    throw new Error('unexpected network endpoint');
  };
  const status=[];
  const feed=new PrivateAuthorizedChartFeed(account,instrument,text=>status.push(text),{
    fetcher,socketFactory:()=>{throw Error('no WSS for historical test');},
    location:{protocol:'https:',host:'qsyn.invalid'},
  });
  const result=await feed.getBars({
    exchange:'UPSTOX_PRIVATE',symbol:instrument,interval:'1m',
  });
  assert.deepEqual(result,bars);
  assert.equal(calls.length,3);
  assert.equal(calls[2].path,'/qsyn/private-chart/history');
  assert.equal(calls[2].options.credentials,'same-origin');
  assert.equal(calls[2].options.headers.Authorization,'Bearer '+ticket);
  assert.ok(status.at(-1).includes('Licensed historical'));
  assert.equal(calls.some(x=>x.path.includes('/studio')),false);
  feed.destroy();
});
test('foreign, duplicate or malformed account history is rejected without demo fallback', async ()=>{
  let response = null;
  const fetcher=async path=>{
    if(path==='/qsyn/api/v1/auth/state')return {ok:true,json:async()=>({
      authenticated:true,csrf,profile:'mock-only'})};
    if(path==='/qsyn/api/v1/terminal/private-chart-grant')return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',account_id:account,
      instrument,transport:'operator_private_wss_only',trading_enabled:false,
      public_redistribution_allowed:false,ticket,expires_ms:Date.now()+15_000,
    })};
    if(path==='/qsyn/private-chart/history') return {ok:true,json:async()=>response};
    throw Error('unexpected request');
  };
  const statuses=[];
  const feed=new PrivateAuthorizedChartFeed(account,instrument,x=>statuses.push(x),{
    fetcher,location:{protocol:'https:',host:'qsyn.invalid'},
  });
  const requested={exchange:'UPSTOX_PRIVATE',symbol:instrument,interval:'1m'};
  const t=Math.floor(Date.now()/60000)*60 - 86400;
  response={schema:'QSYN-UPSTOX-PRIVATE-HISTORY/1',source:'licensed_private_history',
    account:'OTHER',instrument,exchange:'UPSTOX_PRIVATE',interval:'1m',
    trading_enabled:false,public_redistribution_allowed:false,
    bars:[{time:t,open:100,high:102,low:98,close:101}]};
  assert.deepEqual(await feed.getBars(requested),[]);
  response.account=account;
  response.bars.push({...response.bars[0]});
  assert.deepEqual(await feed.getBars(requested),[]);
  response.bars=[{time:t,open:100,high:99,low:98,close:101}];
  assert.deepEqual(await feed.getBars(requested),[]);
  assert.ok(statuses.at(-1).includes('no demo'));
  feed.destroy();
});

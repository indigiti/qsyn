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

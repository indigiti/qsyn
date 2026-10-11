import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePrivateChartScope, isIndexInstrumentKey, fetchPrivateChartGrant, PrivateAuthorizedChartFeed,
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

test('canonical NSE/BSE index keys are private-only and supported without relaxing FO checks', async () => {
  assert.equal(isIndexInstrumentKey('NSE_INDEX|Nifty 50'),true);
  assert.equal(isIndexInstrumentKey('BSE_INDEX|SENSEX'),true);
  assert.equal(validatePrivateChartScope(account,'NSE_INDEX|Nifty 50'),true);
  assert.equal(validatePrivateChartScope(account,'NSE_INDEX|Nifty/50'),false);
  assert.equal(validatePrivateChartScope(account,'NSE_INDEX|../secret'),false);
  const requests=[];
  const feed = new PrivateAuthorizedChartFeed(account,'NSE_INDEX|Nifty 50',()=>{},{
    fetcher:async (...args)=>{requests.push(args);throw Error('must not request FO history');},
    location:{protocol:'https:',host:'qsyn.invalid'},
  });
  assert.deepEqual(await feed.getBars({
    exchange:'UPSTOX_PRIVATE',symbol:'NSE_INDEX|Nifty 50',interval:'1m',
  }),[]);
  assert.equal(requests.some(([url])=>url==='/qsyn/private-chart/history'),false,
    'index must never request option history');
  feed.destroy();
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

test('private Upstox index WSS renews before the 30s grant expires and stops on revocation', async () => {
  const sockets=[], timers=[], paths=[], statuses=[];
  let grantNumber=0, expiry=0, deny=false;
  const schedule=(cb,ms)=>{
    const timer={cb,ms,active:true};timers.push(timer);return timer;
  };
  const cancel=timer=>{timer.active=false;};
  const fetcher=async (path,options)=>{
    paths.push({path,options});
    if(path==='/qsyn/api/v1/auth/state')return {ok:true,json:async()=>({
      authenticated:true,csrf,profile:'mock-only',
    })};
    assert.equal(path,'/qsyn/api/v1/terminal/private-chart-grant');
    if(deny)return {ok:false,status:403};
    grantNumber++;
    expiry=Date.now()+30_000;
    return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',
      account_id:account,instrument:'NSE_INDEX|Nifty 50',
      transport:'operator_private_wss_only',trading_enabled:false,
      public_redistribution_allowed:false,ticket:'private-ticket-'+grantNumber,
      expires_ms:expiry,
    })};
  };
  const socketFactory=url=>{
    assert.equal(url,'wss://qsyn.test/qsyn/private-chart/ws');
    const socket={
      sent:[],closed:false,
      send(message){this.sent.push(JSON.parse(message));},
      close(){this.closed=true;},
      message(obj){this.onmessage?.({data:JSON.stringify(obj)});},
    };
    sockets.push(socket);
    return socket;
  };
  const instrument='NSE_INDEX|Nifty 50';
  const feed=new PrivateAuthorizedChartFeed(account,instrument,x=>statuses.push(x),{
    fetcher,socketFactory,location:{protocol:'https:',host:'qsyn.test'},
    schedule,cancel,
  });
  const stop=feed.subscribeBars({exchange:'UPSTOX_PRIVATE',symbol:instrument,interval:'1m'},
    ()=>{});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  await flush();
  assert.equal(sockets.length,1);
  sockets[0].onopen();
  assert.deepEqual(sockets[0].sent,[{action:'authenticate',token:'private-ticket-1'}]);
  sockets[0].message({type:'authentication_success',
    source:'licensed_private_chart',expires_ms:expiry});
  const refresh=timers.find(t=>t.active);
  assert.ok(refresh && refresh.ms >= 1000 && refresh.ms <= 20000);
  refresh.active=false;refresh.cb();
  await flush();
  assert.equal(sockets[0].closed,true,'expired socket must be rotated');
  const reconnect=timers.find(t=>t.active);
  assert.equal(reconnect.ms,0);
  reconnect.active=false;reconnect.cb();
  await flush();
  assert.equal(sockets.length,2);
  sockets[1].onopen();
  assert.deepEqual(sockets[1].sent,[{action:'authenticate',token:'private-ticket-2'}]);
  sockets[1].message({type:'authentication_success',
    source:'licensed_private_chart',expires_ms:expiry});
  // Next renewal gets 403 and stops; no retry against revoked rights.
  deny=true;
  const refresh2=timers.find(t=>t.active);
  refresh2.active=false;refresh2.cb();
  const reconnect2=timers.find(t=>t.active);
  assert.equal(reconnect2.ms,0);
  reconnect2.active=false;reconnect2.cb();
  await flush();
  assert.equal(feed.session,null,'revoked entitlement must end the subscription');
  assert.equal(timers.filter(t=>t.active).length,0);
  assert.ok(statuses.some(x=>x.includes('revoked')));
  assert.equal(paths.some(x=>x.path.includes('/studio')),false);
  assert.equal(paths.some(x=>x.path.includes('private-ticket-')),false);
  stop();
  feed.destroy();
});

test('private WSS disconnect retries are bounded and cleanup cancels timers', async () => {
  const sockets=[],timers=[];
  const instrument='BSE_INDEX|SENSEX';
  const fetcher=async path=>path.endsWith('/auth/state')
    ? {ok:true,json:async()=>({authenticated:true,csrf,profile:'mock-only'})}
    : {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',account_id:account,
      instrument,transport:'operator_private_wss_only',
      trading_enabled:false,public_redistribution_allowed:false,
      ticket:'private-sensex-ticket',expires_ms:Date.now()+30_000,
    })};
  const feed=new PrivateAuthorizedChartFeed(account,instrument,()=>{},{
    fetcher,location:{protocol:'https:',host:'qsyn.test'},
    socketFactory:()=>{const socket={close(){},send(){}};sockets.push(socket);return socket;},
    schedule:(cb,ms)=>{const t={cb,ms,active:true};timers.push(t);return t;},
    cancel:t=>{t.active=false;},
  });
  feed.subscribeBars({exchange:'UPSTOX_PRIVATE',symbol:instrument,interval:'1m'},()=>{});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  await flush();
  for(let i=0;i<6;i++){
    sockets.at(-1).onclose();
    const timer=timers.find(x=>x.active);
    if(i===5){ assert.equal(timer,undefined);break; }
    assert.ok(timer && timer.ms<=16000 && timer.ms>=1000);
    timer.active=false;timer.cb();await flush();
  }
  assert.equal(feed.session,null,'max reconnect failures must fail closed');
  feed.destroy();
});

test('licensed private NIFTY index history requires a matching ticket and source', async () => {
  const instrument='NSE_INDEX|Nifty 50';
  const requests=[];
  const timestamp=Math.floor((Date.now()-86400000)/60000)*60;
  let wrong=false;
  const fetcher=async (url,options)=>{
    requests.push({url,options});
    if(url==='/qsyn/api/v1/auth/state')return {ok:true,json:async()=>({
      authenticated:true,csrf,profile:'mock-only',
    })};
    if(url==='/qsyn/api/v1/terminal/private-chart-grant')return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',
      account_id:account,instrument,transport:'operator_private_wss_only',
      trading_enabled:false,public_redistribution_allowed:false,
      ticket,expires_ms:Date.now()+15000,
    })};
    if(url==='/qsyn/private-chart/index-history')return {ok:true,json:async()=>({
      schema:'QSYN-UPSTOX-PRIVATE-INDEX-HISTORY/1',source:'licensed_private_index_history',
      account: wrong?'OTHER':account,instrument,exchange:'UPSTOX_PRIVATE',interval:'1m',
      trading_enabled:false,public_redistribution_allowed:false,
      bars:[{time:timestamp,open:25000,high:25020,low:24998,close:25010}],
    })};
    throw Error('Index feed requested unsupported endpoint');
  };
  const status=[];
  const feed=new PrivateAuthorizedChartFeed(account,instrument,x=>status.push(x),{
    fetcher,location:{protocol:'https:',host:'qsyn.invalid'},
  });
  const req={exchange:'UPSTOX_PRIVATE',symbol:instrument,interval:'1m'};
  const bars=await feed.getBars(req);
  assert.equal(bars.length,1);
  assert.equal(bars[0].close,25010);
  assert.equal(requests[2].url,'/qsyn/private-chart/index-history');
  assert.equal(requests[2].options.headers.Authorization,'Bearer '+ticket);
  assert.ok(status.at(-1).includes('Licensed historical index'));
  wrong=true;
  assert.deepEqual(await feed.getBars(req),[],'foreign account cannot inject candles');
  assert.ok(status.at(-1).includes('no simulated'));
  assert.equal(requests.some(x=>x.url==='/qsyn/private-chart/history'),false);
  assert.equal(requests.some(x=>x.url.includes('/india/bars')),false);
  feed.destroy();
});


test('operator-only index grant uses QSYN administrator session rather than mock identity', async () => {
  const key='NSE_INDEX|Nifty 50';
  const calls=[];
  const fetcher=async (url, options)=>{
    calls.push({url,options});
    if(url==='/qsyn/api/v1/admin/upstox/private-chart-access')
      return {ok:true,json:async()=>({
        schema:'QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1',
        authenticated:true,profile:'operator-admin',trading_enabled:false,
        account_id:account,csrf,
      })};
    if(url==='/qsyn/api/v1/admin/upstox/private-chart-grant')
      return {ok:true,json:async()=>({
        schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',
        account_id:account,instrument:key,
        transport:'operator_private_wss_only',
        trading_enabled:false,public_redistribution_allowed:false,
        ticket,expires_ms:Date.now()+20000,
      })};
    throw Error('Unexpected mock identity or public endpoint');
  };
  const grant=await fetchPrivateChartGrant(fetcher,account,key,undefined,'operator_admin');
  assert.equal(grant.ticket,ticket);
  assert.deepEqual(calls.map(x=>x.url),[
    '/qsyn/api/v1/admin/upstox/private-chart-access',
    '/qsyn/api/v1/admin/upstox/private-chart-grant',
  ]);
  assert.equal(calls[1].options.headers['X-CSRF-Token'],csrf);
  assert.deepEqual(JSON.parse(calls[1].options.body),{account_id:account,instrument:key});
  await assert.rejects(
    fetchPrivateChartGrant(fetcher,account,'NSE_FO|12345',undefined,'operator_admin'),
    /Unsupported private chart identity scope/);
  const foreign=async (url, options)=>url.endsWith('private-chart-access')
    ? {ok:true,json:async()=>({schema:'QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1',
        authenticated:true,profile:'operator-admin',trading_enabled:false,
        account_id:'FOREIGN',csrf})}
    : fetcher(url,options);
  await assert.rejects(fetchPrivateChartGrant(foreign,account,key,undefined,'operator_admin'),
    /account mismatch/);
  assert.throws(()=>new PrivateAuthorizedChartFeed(account,'NSE_FO|12345',()=>{},{
    authMode:'operator_admin',location:{protocol:'https:',host:'qsyn.test'},
  }),/Invalid private chart identity mode/);
});

test('operator grant 401 and 403 are terminal, with no fallback to mock identity', async () => {
  const key='NSE_INDEX|Nifty 50';
  const calls=[];
  const fetcher=async (url)=>{
    calls.push(url);
    return {ok:false,status:401};
  };
  await assert.rejects(fetchPrivateChartGrant(fetcher,account,key,undefined,'operator_admin'),
    error=>error.status===401);
  assert.deepEqual(calls,['/qsyn/api/v1/admin/upstox/private-chart-access']);
});

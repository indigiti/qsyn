import test from 'node:test';
import assert from 'node:assert/strict';
import {instrumentForPrivateIndex,verifyPrivateIndexLiveGrant,AuthorizedIndexLiveBridge}
  from '../src/private-index-live-bridge.js';

const csrf='a'.repeat(64);
const account='index-operator-primary';
const instrument='NSE_INDEX|Nifty 50';
const now=()=>Date.now();
const passAccess={schema:'QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1',authenticated:true,
  profile:'operator-admin',account_id:account,csrf,trading_enabled:false,
  private_rights_attested:false,live_feed_verified:false};

test('private live only permits two exact index keys',async()=>{
  assert.equal(instrumentForPrivateIndex('NIFTY'),instrument);
  assert.equal(instrumentForPrivateIndex('SENSEX'),'BSE_INDEX|SENSEX');
  assert.equal(instrumentForPrivateIndex('BANKNIFTY'),null);
  assert.equal(instrumentForPrivateIndex('../NIFTY'),null);
  let calls=0;
  const disabled=await verifyPrivateIndexLiveGrant('BANKNIFTY',{
    fetcher:async()=>{calls++;throw Error('no outbound request');}
  });
  assert.equal(disabled,null);assert.equal(calls,0);
  assert.throws(()=>new AuthorizedIndexLiveBridge({
    symbol:'BANKNIFTY',account}),/INVALID_PRIVATE_INDEX_LIVE_SCOPE/);
});

test('token and operator identity alone cannot authorize live WSS',async()=>{
  let issued=0;
  const fetcher=async(path)=>{
    if(path.endsWith('/private-chart-access')) return {ok:true,json:async()=>passAccess};
    issued++;
    return {ok:false,status:403};
  };
  assert.equal(await verifyPrivateIndexLiveGrant('NIFTY',{fetcher}),null);
  assert.equal(issued,1,'grant must be checked independently');
  assert.equal(await verifyPrivateIndexLiveGrant('NIFTY',{
    fetcher:async()=>({ok:false,status:503})}),null);
  const malformed={...passAccess,account_id:'foreign/../../account'};
  assert.equal(await verifyPrivateIndexLiveGrant('NIFTY',{
    fetcher:async()=>({ok:true,json:async()=>malformed})}),null);
});

test('scope validation preserves the approved exact instrument and local ticket transport',async()=>{
  const requests=[];
  const fetcher=async(path,init)=>{
    requests.push({path,init});
    if(path.endsWith('/private-chart-access'))
      return {ok:true,json:async()=>passAccess};
    assert.equal(path,'/qsyn/api/v1/admin/upstox/private-chart-grant');
    assert.deepEqual(JSON.parse(init.body),{account_id:account,instrument});
    assert.equal(init.headers['X-CSRF-Token'],csrf);
    return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',account_id:account,
      instrument,transport:'operator_private_wss_only',
      public_redistribution_allowed:false,trading_enabled:false,
      ticket:'short-lived-private-ticket',expires_ms:now()+20_000
    })};
  };
  assert.deepEqual(await verifyPrivateIndexLiveGrant('NIFTY',{fetcher}),
    {account,instrument});
  assert.equal(requests.filter(v=>v.path.endsWith('/private-chart-access')).length,2);
  assert.equal(requests.filter(v=>v.path.endsWith('/private-chart-grant')).length,1);
  assert.equal(requests.some(v=>/upstox.com|\/india\/bars/.test(v.path)),false);
});

test('same chart receives only approved timestamped real WSS ticks; disconnect cleans up',async()=>{
  const sockets=[],ticks=[],statuses=[],bars=[];
  const expiresMs=Date.now()+20_000;
  const fetcher=async path=>{
    if(path.endsWith('/private-chart-access'))return {ok:true,json:async()=>passAccess};
    return {ok:true,json:async()=>({
      schema:'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',account_id:account,
      instrument,transport:'operator_private_wss_only',
      public_redistribution_allowed:false,trading_enabled:false,
      ticket:'short-lived-private-ticket',expires_ms:expiresMs
    })};
  };
  const bridge=new AuthorizedIndexLiveBridge({
    symbol:'NIFTY',account,onStatus:s=>statuses.push(s),onTick:t=>ticks.push(t),
    deps:{fetcher,location:{protocol:'https:',host:'qsyn.example'},
      socketFactory:url=>{
        assert.equal(url,'wss://qsyn.example/qsyn/private-chart/ws');
        const ws={closed:false,send(s){this.sent=JSON.parse(s);},close(){this.closed=true;},
          message(o){this.onmessage?.({data:JSON.stringify(o)});}};
        sockets.push(ws);return ws;
      },
      schedule:()=>1,cancel:()=>{}},
  });
  assert.equal(bridge.subscribeBars({symbol:'SENSEX',exchange:'UPSTOX_PERSONAL',
    interval:'1m'},()=>{}).constructor,Function);
  assert.equal(sockets.length,0);
  const stop=bridge.subscribeBars({symbol:'NIFTY',exchange:'UPSTOX_PERSONAL',
    interval:'1m'},bar=>bars.push(bar));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sockets.length,1);
  sockets[0].onopen();
  assert.equal(sockets[0].sent.action,'authenticate');
  sockets[0].message({type:'authentication_success',source:'licensed_private_chart',
    expires_ms:expiresMs});
  assert.equal(ticks.length,0,'authenticated WSS cannot claim verified live tick');
  const timeMs=Date.now()-750;
  const item={schema:'QSYN-PRIVATE-CHART-TICK/1',source:'private_verified_ltp',
    account,instrument,tenant:'index-tenant',time_ms:timeMs,price:25010.45};
  sockets[0].message({...item,source:'simulated'});
  sockets[0].message({...item,account:'different-account'});
  assert.equal(ticks.length,0);
  sockets[0].message(item);
  assert.deepEqual(ticks,[timeMs]);
  assert.ok(bars.length>0,'existing CandleBuilder must forward a real 1m update');
  sockets[0].message(item);
  assert.equal(ticks.length,1,'duplicate exchange timestamp ignored');
  stop();bridge.destroy();
  assert.equal(sockets[0].closed,true);
});

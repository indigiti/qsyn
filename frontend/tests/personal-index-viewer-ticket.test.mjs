import test from 'node:test';
import assert from 'node:assert/strict';
import {PrivateIndexHistoryFeed,personalIndexRequestHeaders}
  from '../src/personal-index-feed.js';

test('history and live tickets share the owner-only authorization header contract',()=>{
  const owner=personalIndexRequestHeaders(true,null);
  assert.equal(owner['X-QSYN-View-Only'],'1');
  assert.equal(Object.hasOwn(owner,'X-CSRF-Token'),false);
  const admin=personalIndexRequestHeaders(false,'a'.repeat(64));
  assert.equal(admin['X-CSRF-Token'],'a'.repeat(64));
  assert.equal(Object.hasOwn(admin,'X-QSYN-View-Only'),false);
  assert.equal(admin['Content-Type'],'application/json');
  assert.equal(owner['Accept'],'application/json');
});

test('authorized owner live ticket sends X-QSYN-View-Only (not admin CSRF)',async()=>{
  const saved={Date:globalThis.Date,fetch:globalThis.fetch,
    WebSocket:globalThis.WebSocket,window:globalThis.window};
  const fixed=saved.Date.parse('2026-10-14T11:00:00+05:30');
  const requests=[],sockets=[];
  let feed,stop;
  try{
    globalThis.Date=class extends saved.Date{
      constructor(...args){super(...(args.length?args:[fixed]));}
      static now(){return fixed;}
    };
    globalThis.window={location:{origin:'https://owner.example',protocol:'https:'}};
    globalThis.WebSocket=class{
      constructor(url){sockets.push(url);}
      close(){}
    };
    globalThis.fetch=async(url,options)=>{
      requests.push({url,options});
      return {ok:true,status:200,json:async()=>({
        schema:'QSYN-PERSONAL-INDEX-RUST-TICKET/1',
        symbol:'NIFTY',trading_enabled:false,
        websocket_path:'/qsyn/ws/personal-index',ticket:'test-ticket-not-real'
      })};
    };
    feed=new PrivateIndexHistoryFeed({
      symbol:'NIFTY',day:'2026-10-14',csrf:null,ownerViewer:true,
      onStatus:()=>{},onLive:()=>{}
    });
    stop=feed.subscribeBars({symbol:'NIFTY',exchange:'UPSTOX_PERSONAL',
      interval:'1m'},()=>{});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(requests.length,1,'live connection must ask for one ticket');
    assert.equal(requests[0].url,'/qsyn/api/v1/owner-index/ticket');
    assert.equal(requests[0].options.method,'POST');
    assert.equal(requests[0].options.credentials,'same-origin');
    assert.equal(requests[0].options.headers['X-QSYN-View-Only'],'1');
    assert.equal(Object.hasOwn(requests[0].options.headers,'X-CSRF-Token'),false);
    assert.deepEqual(JSON.parse(requests[0].options.body),{symbol:'NIFTY'});
    assert.deepEqual(sockets,['wss://owner.example/qsyn/ws/personal-index']);
  }finally{
    stop?.();feed?.destroy();
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined)delete globalThis[key];
      else globalThis[key]=value;
    }
  }
});

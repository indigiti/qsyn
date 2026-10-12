import assert from 'node:assert/strict';
import {MARKET_FAMILIES,MARKET_PROVIDERS,DEFAULT_MARKET,catalogFor,
  providerFor,scopedInstrumentId,providerEvidence,fetchSimulatedResearch} from '../src/market-model.js';
import {readFileSync} from 'node:fs';
const registry=JSON.parse(readFileSync(
  new URL('../../apps/web-php/public/market-provider-registry.json',import.meta.url),'utf8'));
assert.equal(registry.schema,'QSYN-MARKET-PROVIDER-REGISTRY/1');
assert.equal(DEFAULT_MARKET,'crypto');
assert.deepEqual(MARKET_FAMILIES.map(x=>x.id),['crypto','indices','stocks','options']);
assert.equal(new Set(MARKET_PROVIDERS.map(x=>x.id)).size,MARKET_PROVIDERS.length);
assert.equal(MARKET_PROVIDERS.filter(p=>p.adapter==='public_crypto').length,7);
assert.equal(catalogFor('indices').length,6);
assert(catalogFor('crypto').length>12);
for(const m of MARKET_FAMILIES)for(const id of m.providers){
  assert(providerFor(id).asset_classes.includes(m.id));
}
assert.equal(providerEvidence({market:'indices',provider:'upstox',
  tokenStatus:{schema:'QSYN-UPSTOX-ANALYTICS-STATUS/1',token_stored:true}})
  .streaming,'not_verified');
assert.equal(providerEvidence({market:'indices',provider:'upstox',
  operatorPreflight:{schema:'QSYN-INDEX-ACTIVATION-PREFLIGHT/1',
    worker_process_verified_now:false,display_rights_verified_now:false},
  tokenStatus:{schema:'QSYN-UPSTOX-ANALYTICS-STATUS/1',token_stored:true}})
  .display,'not_verified');
assert.equal(providerEvidence({market:'crypto',provider:'binance',
  health:{schema:'QSYN-PUBLIC-CRYPTO-HEALTH/1',exchange:'BINANCE',
    source:'exchange_public',trading_enabled:false,feed:{}}
}).connection,'responding');
assert.equal(providerEvidence({market:'crypto',provider:'binance',
  health:{schema:'QSYN-PUBLIC-CRYPTO-HEALTH/1',exchange:'BYBIT',
    source:'exchange_public',trading_enabled:false,feed:{}}
}).connection,'not_verified');
const a=scopedInstrumentId({market:'indices',venue:'NSE_INDEX',provider:'upstox',
  account_id:'account-a',symbol:'NIFTY'});
const b=scopedInstrumentId({market:'indices',venue:'NSE_INDEX',provider:'upstox',
  account_id:'account-b',symbol:'NIFTY'});
assert.notEqual(a,b,'independent Upstox accounts cannot share a cache key');
assert.throws(()=>scopedInstrumentId({market:'indices',venue:'NSE_INDEX',
  provider:'upstox',symbol:'NIFTY'}));
assert.throws(()=>scopedInstrumentId({market:'crypto',venue:'BINANCE',
  provider:'binance',symbol:'BTCUSDT',account_id:'foreign'}));
assert.throws(()=>providerEvidence({market:'crypto',provider:'upstox'}));
let lastRequest=null;
const source={mode:'simulated',source:'deterministic-options-laboratory',
  broker_connected:false,trading_enabled:false};
const mock=async (url,options)=>{
  lastRequest={url,options};
  return {ok:true,json:async()=>source};
};
assert.equal((await fetchSimulatedResearch('market?underlying=NIFTY',undefined,mock)).mode,
  'simulated');
assert.equal(lastRequest.url,'/qsyn/api/v1/studio/market?underlying=NIFTY');
assert.equal(lastRequest.options.credentials,'same-origin');
const config=new URLSearchParams({underlying:'NIFTY',expiry:'W1',interval:'1m',
  legs:JSON.stringify([{type:'CE',side:'BUY',strike:23000,qty:1}])});
await fetchSimulatedResearch('bars?'+config,undefined,mock);
assert.equal(lastRequest.url.includes('bars?'),true);
await assert.rejects(fetchSimulatedResearch('bars?underlying=NIFTY&account_id=SECRET',undefined,mock));
await assert.rejects(fetchSimulatedResearch('market?underlying=NIFTY&underlying=OTHER',undefined,mock));
await assert.rejects(fetchSimulatedResearch('market?underlying=NIFTY',undefined,
  async()=>({ok:true,json:async()=>({...source,source:'licensed_broker_index'})})));
console.log('PASS canonical market/provider registry, strict scope, data evidence and isolated strategy source');

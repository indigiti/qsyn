/**
 * QSYN market/provider contract v1. One reviewable manifest is imported by the
 * browser and served by PHP; no provider credentials or capabilities inferred
 * from a configured provider name.
 */
import registry from '../../apps/web-php/public/market-provider-registry.json' with {type:'json'};
import {CRYPTO_MARKETS} from './crypto-catalog.js';
import {INDIA_INDEX_MARKETS} from './india-index-catalog.js';
const STATES=new Set(['implemented','gated','not_implemented','simulation_only']);
const IDS=new Set();
if(registry.schema!=='QSYN-MARKET-PROVIDER-REGISTRY/1' ||
  registry.defaultMarket!=='crypto' || registry.markets?.length!==4 ||
  !Array.isArray(registry.providers)) throw Error('Invalid market/provider registry');
for(const m of registry.markets){
  if(!['crypto','indices','stocks','options'].includes(m.id) ||
     IDS.has(m.id)||!Array.isArray(m.venues)||!Array.isArray(m.providers)||
     !STATES.has(m.product_state))throw Error('Invalid market family');
  IDS.add(m.id);
}
const PROVIDERS=new Map();
for(const p of registry.providers){
  if(!/^[a-z][a-z0-9_-]+$/.test(p.id)||PROVIDERS.has(p.id) ||
     !['public_crypto','private_upstox','simulated_options'].includes(p.adapter))
    throw Error('Invalid provider contract');
  PROVIDERS.set(p.id,p);
}
for(const m of registry.markets){
  if(!m.providers.every(id=>PROVIDERS.has(id) &&
       PROVIDERS.get(id).asset_classes.includes(m.id))) throw Error('Provider market mismatch');
}
export const MARKET_FAMILIES=Object.freeze(registry.markets.map(m=>Object.freeze(m)));
export const MARKET_PROVIDERS=Object.freeze(registry.providers.map(p=>Object.freeze(p)));
export const DEFAULT_MARKET=registry.defaultMarket;
export const PUBLIC_CRYPTO=Object.freeze(CRYPTO_MARKETS);
export const PRIVATE_INDICES=Object.freeze(INDIA_INDEX_MARKETS);
export function marketFamily(id){return MARKET_FAMILIES.find(m=>m.id===id)||null;}
export function providerFor(id){return PROVIDERS.get(id)||null;}
export function catalogFor(market){
  return market==='crypto'?PUBLIC_CRYPTO:market==='indices'?PRIVATE_INDICES:[];
}
export function scopedInstrumentId({market,venue,provider,symbol,account_id=null}){
  const m=marketFamily(market),p=providerFor(provider);
  if(!m||!p||!m.venues.includes(venue)||!m.providers.includes(provider) ||
     !/^[A-Za-z0-9 _|.:/-]{1,100}$/.test(String(symbol||'')) ||
     (p.account_required && (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(account_id||'')))) ||
     (!p.account_required && account_id!==null))
    throw Error('Invalid market or account scope');
  // Never fold account-scoped broker prices into a globally shared series.
  return JSON.stringify([market,venue,provider,account_id,symbol]);
}
export function isValidCryptoHealth(data,exchange){
  return !!data && data.schema==='QSYN-PUBLIC-CRYPTO-HEALTH/1' &&
    data.exchange===exchange && data.source==='exchange_public' &&
    data.trading_enabled===false && data.feed && typeof data.feed==='object';
}
export function providerEvidence({market,provider,health=null,tokenStatus=null,
  operatorPreflight=null,historyVerified=false,liveTicksVerified=false,
  displayRightsVerified=false}){
  const m=marketFamily(market),p=providerFor(provider);
  if(!m||!p||!m.providers.includes(provider))throw Error('Invalid provider evidence request');
  if(p.adapter==='public_crypto'){
    const verified=isValidCryptoHealth(health,p.venues[0]);
    return Object.freeze({authenticated:'not_required',
      connection:verified?'responding':'not_verified',
      history:verified&&historyVerified?'verified':'not_verified',
      streaming:verified&&liveTicksVerified?'verified':'not_verified',
      display:'public_exchange',last_checked:verified?'probe_now':null});
  }
  if(p.adapter==='simulated_options')
    return Object.freeze({authenticated:'not_required',connection:'simulated',
      history:'simulated',streaming:'not_available',display:'simulation_only',
      last_checked:null});
  const stored=tokenStatus?.schema==='QSYN-UPSTOX-ANALYTICS-STATUS/1' &&
    tokenStatus.token_stored===true;
  // File presence and a historical feed-authorize result cannot attest live
  // exchange ticks or permission to redistribute broker-derived prices.
  const preflight=operatorPreflight?.schema==='QSYN-INDEX-ACTIVATION-PREFLIGHT/1'
    ? operatorPreflight:null;
  return Object.freeze({authenticated:stored?'stored_unverified':'not_verified',
    connection:'not_verified',history:'not_verified',
    streaming:preflight?.worker_process_verified_now===true&&liveTicksVerified?'verified':'not_verified',
    display:preflight?.display_rights_verified_now===true&&displayRightsVerified?'private_approved':'not_verified',
    last_checked:null});
}
/** Central simulation source contract, shared by the existing Strategy Studio.
 * No simulated series is promoted to the public crypto or private index feed.
 */
export async function fetchSimulatedResearch(path,signal,fetcher=fetch){
  if(typeof path!=='string'||path.length>1500||!path.includes('?'))
    throw Error('Invalid strategy research request');
  const [name,query,extra]=path.split('?');
  if(extra!==undefined||!['market','bars'].includes(name))
    throw Error('Invalid strategy research operation');
  const params=new URLSearchParams(query);
  const keys=[...params.keys()];
  const allowed=name==='market'?['underlying']:['underlying','expiry','interval','legs'];
  if(keys.length!==allowed.length || keys.some(k=>!allowed.includes(k)) ||
     new Set(keys).size!==keys.length ||
     !/^[A-Z]{3,18}$/.test(params.get('underlying')||'') ||
     (name==='bars' && (
       !/^(W1|W2|M1)$/.test(params.get('expiry')||'') ||
       !/^(1m|5m|15m)$/.test(params.get('interval')||'') ||
       (params.get('legs')||'').length>1000)))
    throw Error('Invalid strategy research scope');
  const response=await fetcher('/qsyn/api/v1/studio/'+path,{
    credentials:'same-origin',cache:'no-store',signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('Simulation endpoint unavailable ('+response.status+')');
  const data=await response.json();
  if(data.mode!=='simulated'||data.source!=='deterministic-options-laboratory' ||
     data.trading_enabled!==false||data.broker_connected!==false)
    throw Error('Unexpected data source; strategy chart blocked');
  return data;
}

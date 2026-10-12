/** Join the existing operator-private WSS adapter to a *personal* historical
 * chart. Never treat a stored Analytics Token or operator login as live rights.
 * This module stores no bearer/ticket, publishes no public index endpoint, and
 * preserves the provider's exchange timestamp rather than client arrival time.
 */
import {fetchPrivateChartGrant,PrivateAuthorizedChartFeed} from './private-live-chart.js';

const INDEX_KEYS=Object.freeze({
  NIFTY:'NSE_INDEX|Nifty 50',
  SENSEX:'BSE_INDEX|SENSEX',
});
const ACCESS='/qsyn/api/v1/admin/upstox/private-chart-access';
const ACCOUNT=/^[A-Za-z0-9_.:-]{1,128}$/;

export function instrumentForPrivateIndex(symbol){
  return Object.hasOwn(INDEX_KEYS,symbol)?INDEX_KEYS[symbol]:null;
}

export async function verifyPrivateIndexLiveGrant(symbol,{fetcher=fetch,signal}={}){
  const key=instrumentForPrivateIndex(symbol);
  if(!key)return null;
  // The access request is only a scope discovery. A separately issued
  // instrument-bound grant is required before any live subscription.
  try{
    const response=await fetcher(ACCESS,{
      credentials:'same-origin',cache:'no-store',signal,
      headers:{Accept:'application/json'},
    });
    if(!response.ok||signal?.aborted)return null;
    const identity=await response.json();
    if(identity.schema!=='QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1'
      || identity.authenticated!==true||identity.profile!=='operator-admin'
      || identity.trading_enabled!==false||!ACCOUNT.test(identity.account_id)
      || !/^[a-f0-9]{64}$/.test(identity.csrf))return null;
    await fetchPrivateChartGrant(fetcher,identity.account_id,key,signal,'operator_admin');
    return signal?.aborted?null:Object.freeze({account:identity.account_id,instrument:key});
  }catch{return null;}
}

/** The chart owns this adapter. A revoked grant must terminate live updates. */
export class AuthorizedIndexLiveBridge {
  constructor({symbol,account,onStatus=()=>{},onTick=()=>{},deps={}}){
    const instrument=instrumentForPrivateIndex(symbol);
    if(!instrument||!ACCOUNT.test(account))throw Error('INVALID_PRIVATE_INDEX_LIVE_SCOPE');
    this.symbol=symbol;
    this.closed=false;
    this.feed=new PrivateAuthorizedChartFeed(account,instrument,onStatus,{
      ...deps,authMode:'operator_admin',
      onVerifiedTick:(timeMs)=>{
        if(!this.closed)onTick(timeMs);
      },
    });
    this.instrument=instrument;
  }
  subscribeBars(req,onBar){
    if(this.closed||req.symbol!==this.symbol||
      req.exchange!=='UPSTOX_PERSONAL'||req.interval!=='1m')return ()=>{};
    return this.feed.subscribeBars({...req,exchange:'UPSTOX_PRIVATE',
      symbol:this.instrument},onBar);
  }
  destroy(){this.closed=true;this.feed.destroy();}
}

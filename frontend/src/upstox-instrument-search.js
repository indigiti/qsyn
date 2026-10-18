/** Account-private Upstox discovery. Symbol visibility is not candle availability. */
export const SEARCH_ENDPOINT='/qsyn/api/v1/admin/upstox/instruments/search';
export const SEARCH_SCHEMA='QSYN-UPSTOX-INSTRUMENT-SEARCH/1';
const safeFilter=new Set(['ALL','NSE','BSE','MCX','EQ','FO','INDEX','OPT','FUT','COMM','CURR','CE','PE']);
export function instrumentSearchParams({query,exchange='ALL',segment='ALL',type='',expiry='',page=1}){
  const q=String(query??'').trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9 .&+_/-]{1,49}$/.test(q))
    throw Error('Enter at least two characters of a valid symbol or name');
  for(const value of [exchange,segment,...(type?[type]:[])]){
    if(!safeFilter.has(value))throw Error('Unsupported Upstox instrument filter');
  }
  const params=new URLSearchParams({query:q,page_number:String(page),records:'20'});
  if(exchange!=='ALL')params.set('exchanges',exchange);
  if(segment!=='ALL')params.set('segments',segment);
  if(type)params.set('instrument_types',type);
  if(expiry)params.set('expiry',expiry);
  if(!Number.isInteger(page)||page<1||page>100)throw Error('Invalid results page');
  return params;
}
export async function searchUpstoxInstruments(filters,{signal,fetcher=fetch}={}){
  const url=SEARCH_ENDPOINT+'?'+instrumentSearchParams(filters);
  const response=await fetcher(url,{credentials:'same-origin',cache:'no-store',
    headers:{Accept:'application/json'},signal});
  if(!response.ok){
    if(response.status===401)throw Error('Sign in to QSYN Terminal to search');
    if(response.status===409)throw Error('Configure the Upstox Analytics Token in Data Providers');
    if(response.status===422)throw Error('Invalid symbol or filter');
    throw Error('Upstox instrument search unavailable ('+response.status+')');
  }
  const data=await response.json();
  if(data?.schema!==SEARCH_SCHEMA||data.source!=='upstox_instrument_search_v2'
     ||data.data_state!=='discovery_only'||data.history_verified!==false
     ||data.live_feed_verified!==false||data.trading_enabled!==false
     ||!Array.isArray(data.instruments)||data.instruments.length>30
     ||!Number.isInteger(data.total_pages)||!Number.isInteger(data.page_number))
    throw Error('Invalid Upstox instrument search response');
  for(const item of data.instruments){
    if(typeof item.instrument_key!=='string'||typeof item.trading_symbol!=='string'
      ||typeof item.exchange!=='string'||typeof item.segment!=='string')
      throw Error('Invalid Upstox instrument record');
  }
  return data;
}

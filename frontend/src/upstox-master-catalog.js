/** Private NSE/BSE BOD symbol catalog. A list entry is not a price entitlement. */
export const MASTER_ENDPOINT='/qsyn/api/v1/admin/upstox/instruments/master';
const SCHEMA='QSYN-UPSTOX-BOD-MASTER/1';
const SEGMENTS=new Set(['ALL','EQ','FO','INDEX','CURR','COMM']);
const TYPES=new Set(['ALL','EQ','CE','PE','FUT','INDEX']);

export function masterParams({exchange='NSE',segment='EQ',type='ALL',query='',page=1}){
  if(!['NSE','BSE'].includes(exchange)||!SEGMENTS.has(segment)||!TYPES.has(type)
    ||!Number.isSafeInteger(page)||page<1||page>100000)
    throw Error('Invalid NSE/BSE master filters');
  const search=String(query??'').trim();
  if(search.length>50||(search&&!/^[A-Za-z0-9][A-Za-z0-9 .&+_/-]{0,49}$/.test(search)))
    throw Error('Invalid master search');
  return new URLSearchParams({exchange,segment,type,query:search,
    page:String(page),records:'20'});
}

export async function masterStatus({signal,fetcher=fetch}={}){
  const r=await fetcher(MASTER_ENDPOINT+'?mode=status',
    {credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal});
  if(!r.ok)throw Error('Master catalog status unavailable');
  const data=await r.json();
  if(data?.schema!==SCHEMA||typeof data.catalog_ready!=='boolean'
    ||data.data_state!=='discovery_only'||data.history_verified!==false
    ||data.live_feed_verified!==false||data.trading_enabled!==false)
    throw Error('Invalid master catalog status');
  return data;
}

export async function browseMaster(filters,{signal,fetcher=fetch}={}){
  const r=await fetcher(MASTER_ENDPOINT+'?'+masterParams(filters),
    {credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal});
  if(!r.ok){
    if(r.status===401)throw Error('Sign in to QSYN Terminal');
    if(r.status===409)throw Error('NSE/BSE master not yet imported by administrator');
    throw Error('Master catalog unavailable ('+r.status+')');
  }
  const data=await r.json();
  if(data?.schema!==SCHEMA||data.source!=='upstox_official_bod_json'
    ||data.data_state!=='discovery_only'||data.history_verified!==false
    ||data.live_feed_verified!==false||data.trading_enabled!==false
    ||!Array.isArray(data.instruments)||data.instruments.length>30
    ||!Number.isSafeInteger(data.page_number)||!Number.isSafeInteger(data.total_pages)
    ||!Number.isSafeInteger(data.total_records)||data.total_records<0
    ||!['NSE','BSE'].includes(data.exchange))
    throw Error('Invalid NSE/BSE master catalog response');
  for(const item of data.instruments){
    if(typeof item.instrument_key!=='string'||typeof item.trading_symbol!=='string'
      ||typeof item.exchange!=='string'||typeof item.segment!=='string'
      ||(item.selection_scope!==null && typeof item.selection_scope!=='string'))
      throw Error('Invalid master instrument record');
  }
  return data;
}

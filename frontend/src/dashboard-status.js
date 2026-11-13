/**
 * Dashboard uses only already-authorized, read-only QSYN endpoints.
 * A saved token, imported BOD catalog, and enabled browser switch are NOT
 * evidence of connected live Upstox market data or trade permissions.
 */
const ENDPOINTS={
  analytics:'/qsyn/api/v1/admin/upstox/analytics/status',
  master:'/qsyn/api/v1/admin/upstox/instruments/master?mode=status',
  diagnostics:'/qsyn/api/v1/admin/diagnostics/report'
};
const HEADERS={Accept:'application/json'};
async function read(url,fetcher,signal){
  try{
    const response=await fetcher(url,{
      credentials:'same-origin',cache:'no-store',headers:HEADERS,signal
    });
    return response.ok ? await response.json() : null;
  }catch{return null;}
}
function validMaster(value){
  return value?.schema==='QSYN-UPSTOX-BOD-MASTER/1' &&
    typeof value.catalog_ready==='boolean' &&
    value.data_state==='discovery_only' && value.trading_enabled===false &&
    value.history_verified===false && value.live_feed_verified===false;
}
export function normalizeDashboardStatus({analytics,master,diagnostics}){
  const account=analytics?.schema==='QSYN-UPSTOX-ANALYTICS-STATUS/1' &&
      analytics.trading_enabled===false && typeof analytics.token_stored==='boolean'
    ?(analytics.token_stored?'stored':'missing'):'unavailable';
  let catalog='unavailable',counts=null,importDay=null,today=false;
  if(validMaster(master)){
    catalog=master.catalog_ready?'ready':'missing';
    if(catalog==='ready' && typeof master.imported_day_ist==='string' &&
      /^20\d{2}-\d{2}-\d{2}$/.test(master.imported_day_ist) &&
      Number.isSafeInteger(master.exchange_counts?.NSE) &&
      Number.isSafeInteger(master.exchange_counts?.BSE) &&
      master.exchange_counts.NSE>=0 && master.exchange_counts.BSE>=0){
      counts={NSE:master.exchange_counts.NSE,BSE:master.exchange_counts.BSE};
      importDay=master.imported_day_ist;
      today=master.imported_today_ist===true;
    }else if(catalog==='ready'){
      catalog='unavailable';
    }
  }
  let live='unavailable';
  if(diagnostics?.schema==='QSYN-ADMIN-DIAGNOSTICS/1' &&
    diagnostics.admin?.authenticated===true &&
    diagnostics.trading_enabled===false &&
    typeof diagnostics.live_index_feed_verified==='boolean'){
    live=diagnostics.live_index_feed_verified?'verified':'unverified';
  }
  return {account,catalog,counts,importDay,today,live};
}
export async function fetchDashboardStatus({fetcher=fetch,signal,onProbe,timeoutMs=5000}={}){
  const entries=await Promise.all(Object.entries(ENDPOINTS).map(async ([key,url])=>{
    const controller=new AbortController();
    let timer,stop;
    const deadline=new Promise(resolve=>{
      stop=()=>{controller.abort();resolve(null);};
      timer=setTimeout(stop,timeoutMs);
      if(signal?.aborted)stop();
      else signal?.addEventListener('abort',stop,{once:true});
    });
    let value;
    try{
      value=await Promise.race([deadline,read(url,fetcher,controller.signal)]);
    }finally{
      clearTimeout(timer);
      signal?.removeEventListener('abort',stop);
    }
    if(!signal?.aborted)onProbe?.(key,normalizeDashboardStatus({[key]:value}));
    return [key,value];
  }));
  return normalizeDashboardStatus(Object.fromEntries(entries));
}

#!/usr/bin/env node
/**
 * Read-only staging access diagnostic. Public endpoints only.
 * No authentication, bypass, sensitive response bodies, or raw headers.
 * A 403 on GitHub-hosted runners may be a perimeter/WAF restriction:
 * this probe collects enough safe metadata to distinguish it from QSYN API
 * authorization. Never disable a protective rule to make CI green.
 */
import {pathToFileURL} from 'node:url';

const HEADER_ALLOWLIST=['server','content-type','cf-ray','cf-mitigated','x-request-id',
  'x-correlation-id','x-sucuri-id','x-sucuri-block','x-cache','via','retry-after'];
const CHECKS=[
  {name:'homepage',path:'/',accept:'text/html'},
  {name:'health',path:'/api/v1/health',accept:'application/json'},
  {name:'public_crypto_bar',path:'/api/v1/crypto/bars?exchange=BINANCE&market=spot&symbol=BTCUSDT&interval=1m&limit=1',accept:'application/json'},
];
function safeHeaders(headers){
  const result={};
  for(const name of HEADER_ALLOWLIST){
    const value=headers?.get?.(name);
    if(typeof value==='string'&&value.length<180&&/^[\w .:;/=-]+$/.test(value))
      result[name]=value;
  }
  return result;
}
function classifyResponse(status,headers,text){
  const body=String(text||'').slice(0,6000).toLowerCase();
  const type=headers?.get?.('content-type')||'';
  const signals=[];
  for(const [tag,pattern] of [
    ['cloudflare_challenge',/cloudflare|cf-chl|challenge-platform|just a moment/],
    ['waf_denial',/web application firewall|modsecurity|access denied|request blocked|sucuri/],
    ['application_json',/"schema"\s*:|"code"\s*:|"error"\s*:/],
  ])if(pattern.test(body))signals.push(tag);
  return {
    body_type:/json/i.test(type)?'json':/html/i.test(type)?'html':type?'other':'unknown',
    observed_signals:signals,
    access_denied:status===401||status===403,
    // A WAF is suspected when HTML/known edge fingerprints accompany 403;
    // only hosting logs can confirm which security rule denied the request.
    likely_layer:(status===401||status===403)?
      ((/html/i.test(type)||signals.some(x=>x==='cloudflare_challenge'||x==='waf_denial'))?
        'edge_or_server_access_control_suspected':'undetermined_access_control'):'not_denied',
  };
}
export async function probeStageAccess({
  base='https://stage.digiti.in/qsyn',fetchFn=globalThis.fetch,timeoutMs=10000
}={}){
  const root=new URL(base);
  if(root.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(root.hostname))
    throw new Error('Public staging diagnostic requires HTTPS');
  const path=root.pathname.replace(/\/+$/,'');
  const result={
    schema:'QSYN-STAGE-ACCESS-DIAGNOSTIC/1',
    checked_at_utc:new Date().toISOString(),
    origin:root.origin+path,
    checks:[],
  };
  for(const check of CHECKS){
    const suffix=check.path==='/'?'/':check.path;
    const url=new URL(path+suffix,root);
    try{
      const response=await fetchFn(url,{
        method:'GET',cache:'no-store',headers:{Accept:check.accept},
        signal:AbortSignal.timeout(timeoutMs),
      });
      // Never log response bodies: they may contain IDs, HTML, or secrets.
      const body=await response.text();
      result.checks.push({
        endpoint:check.name,http_status:response.status,
        headers:safeHeaders(response.headers),
        ...classifyResponse(response.status,response.headers,body),
      });
    }catch(error){
      result.checks.push({
        endpoint:check.name,http_status:null,
        transport_error:error?.name==='TimeoutError'?'timeout':'connection_failed',
      });
    }
  }
  const denied=result.checks.filter(x=>x.access_denied);
  result.status=denied.length?'access_denied':
    result.checks.some(x=>x.http_status===null)?'network_incomplete':'reachable';
  result.stage_403_not_a_history_validation=result.checks.some(x=>x.endpoint==='public_crypto_bar'&&x.http_status===403);
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await probeStageAccess();
  console.log(JSON.stringify(result,null,2));
}

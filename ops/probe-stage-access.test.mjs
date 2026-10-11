import assert from 'node:assert/strict';
import {test} from 'node:test';
import {probeStageAccess} from './probe-stage-access.mjs';

test('403 with CDN HTML signature is diagnosed without leaking body, IP or cookies',async()=>{
  const seen=[];
  const fetchFn=async url=>{
    const u=new URL(url),path=u.pathname;
    seen.push(path);
    if(path.endsWith('/crypto/bars'))return new Response(
      '<html>Cloudflare Attention required: access denied</html>',{
        status:403,headers:{
          'content-type':'text/html','cf-ray':'abc123-DEN',
          'set-cookie':'secret-session=should-never-be-recorded',
        },
      });
    if(path.endsWith('/health'))return new Response('{"status":"ok"}',{
      status:200,headers:{'content-type':'application/json'}});
    return new Response('<html>Home</html>',{status:200,headers:{'content-type':'text/html'}});
  };
  const report=await probeStageAccess({base:'https://stage.digiti.in/qsyn',fetchFn});
  assert.equal(report.checks.length,3);
  assert.equal(report.status,'access_denied');
  assert.equal(report.stage_403_not_a_history_validation,true);
  assert.deepEqual(seen,['/qsyn/','/qsyn/api/v1/health','/qsyn/api/v1/crypto/bars']);
  const bad=report.checks[2];
  assert.equal(bad.http_status,403);
  assert.equal(bad.likely_layer,'edge_or_server_access_control_suspected');
  assert.ok(bad.observed_signals.includes('cloudflare_challenge'));
  assert.equal(bad.headers['cf-ray'],'abc123-DEN');
  const reportText=JSON.stringify(report);
  assert.ok(!reportText.includes('secret-session'));
  assert.ok(!reportText.includes('should-never-be-recorded'));
  assert.ok(!reportText.includes('Attention required'));
});
test('application JSON access denial remains undetermined instead of blamed on WAF',async()=>{
  const report=await probeStageAccess({base:'http://localhost/qsyn',fetchFn:async()=>{
    return new Response('{"code":"ACCESS_DENIED","private":"never echo"}',{
      status:403,headers:{'content-type':'application/json'}});
  }});
  assert.equal(report.status,'access_denied');
  assert.equal(report.checks[2].likely_layer,'undetermined_access_control');
  assert.ok(!JSON.stringify(report).includes('never echo'));
});
test('network errors are reported per endpoint and probe proceeds',async()=>{
  let n=0;
  const report=await probeStageAccess({base:'https://stage.digiti.in/qsyn',fetchFn:async()=>{n++;throw Error('fail');}});
  assert.equal(n,3);
  assert.equal(report.status,'network_incomplete');
  assert.ok(report.checks.every(x=>x.transport_error==='connection_failed'));
});
test('does not permit probing arbitrary insecure nonlocal hosts',async()=>{
  await assert.rejects(probeStageAccess({base:'http://example.com/qsyn'}));
});

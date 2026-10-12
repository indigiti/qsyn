<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/src/RustAdmin.php';
require_once dirname(__DIR__).'/src/IndexWebOperations.php';
use QSYN\Index\IndexWebOperations as Ops;
function ensure(bool $ok,string $name):void{
    if(!$ok)throw new RuntimeException('index_web_test_failed:'.$name);
}
$ist=new DateTimeZone('Asia/Kolkata');
$now=new DateTimeImmutable('2026-10-12T15:00:00',$ist);
ensure(Ops::validDay('2026-10-09',$now),'completed_friday');
ensure(Ops::validDay('2026-09-14',$now),'thirty_day_bound');
foreach(['2026-10-12','2026-10-13','2026-10-10','2026-10-11',
  '2026-09-11','2026-02-30','2026-10-09;whoami','/etc/passwd',''] as $bad) {
  ensure(!Ops::validDay($bad,$now),'invalid_date_'.str_replace(['/',';'],'_',$bad));
}
$old=getenv('QSYN_INDEX_WEB_OPERATIONS_ENABLED');
putenv('QSYN_INDEX_WEB_OPERATIONS_ENABLED=0');
[$status,$json]=Ops::dispatch('status',[
 'REQUEST_METHOD'=>'POST','HTTP_HOST'=>'localhost',
]);
ensure($status===405,'method_rejected_before_any_execution');
[$status,$json]=Ops::dispatch('bogus',['REQUEST_METHOD'=>'POST']);
ensure($status===404,'unknown_operation_rejected');
if($old===false)putenv('QSYN_INDEX_WEB_OPERATIONS_ENABLED');
else putenv('QSYN_INDEX_WEB_OPERATIONS_ENABLED='.$old);
// A live worker can be preflight-ready when optional history backfill and
// its separate Supervisor program are not. Emergency stop is per service.
$serviceReady=new ReflectionMethod(Ops::class,'serviceControlReady');
$preflightReady=new ReflectionMethod(Ops::class,'servicePreflightReady');
$state=[
  'workerSupervisorOk'=>true,'historySupervisorOk'=>false,
  'workerPreflightOk'=>true,'historyPreflightOk'=>false
];
ensure($serviceReady->invoke(null,$state,'worker'),'worker_supervisor_independent');
ensure(!$serviceReady->invoke(null,$state,'history'),'history_supervisor_optional');
ensure(!$serviceReady->invoke(null,$state,'unknown'),'unknown_service_denied');
ensure($preflightReady->invoke(null,$state,'worker'),'worker_no_history_preflight_required');
ensure(!$preflightReady->invoke(null,$state,'history'),'import_requires_history_preflight');
$state['workerSupervisorOk']=false;
ensure(!$serviceReady->invoke(null,$state,'worker'),'no_host_supervisor_no_start_stop');
$state['workerPreflightOk']=false;
ensure(!$preflightReady->invoke(null,$state,'worker'),'no_worker_preflight_no_start');

// Simulate Rust's restricted CHECK response only. This never connects to an
// upstream provider, starts a worker or synthesizes live market data.
$tmp=tempnam(sys_get_temp_dir(),'qsyn-index-check-');
ensure(is_string($tmp),'temporary_check_script');
try {
  $reply=json_encode([
    'schema'=>'QSYN-UPSTOX-INDEX-WORKER-READINESS/1',
    'operator_configuration_accepted'=>true,
    'provider_session_currently_verified'=>false,
    'live_index_stream_activated'=>false,
    'trading_enabled'=>false
  ],JSON_THROW_ON_ERROR);
  file_put_contents($tmp,"#!/bin/sh\nprintf '%s\\n' '".str_replace("'","'\\''",$reply)."'\n");
  chmod($tmp,0700);
  $method=new ReflectionMethod(Ops::class,'runWorkerCheck');
  $result=$method->invoke(null,['worker'=>$tmp,'plan'=>'/never-read-in-test']);
  ensure($result['ok']===true && $result['code']==='INDEX_WORKER_PLAN_VALIDATED_NO_FEED_STARTED',
    'worker_check_independent_of_history_cli');
  $history=(new ReflectionMethod(Ops::class,'runCheck'))->invoke(
    null,['worker'=>$tmp,'plan'=>'/never-read-in-test',
      'history'=>'/not-provisioned','archive'=>'/none'],'2026-10-09');
  ensure($history['ok']===false && $history['code']==='INDEX_HISTORY_PREFLIGHT_REJECTED',
    'history_still_requires_own_importer');
  file_put_contents($tmp,"#!/bin/sh\nprintf '%s\\n' '{\"schema\":\"INVALID\",\"operator_configuration_accepted\":true}'\n");
  $bad=$method->invoke(null,['worker'=>$tmp,'plan'=>'/never-read-in-test']);
  ensure($bad['ok']===false && $bad['code']==='INDEX_WORKER_PREFLIGHT_RESPONSE_INVALID',
    'malformed_worker_check_cannot_authorize_start');
}finally{
  if(is_string($tmp) && file_exists($tmp))unlink($tmp);
}
echo "PASS index web operator: completed IST dates, hard denials, command allowlist\n";

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
echo "PASS index web operator: completed IST dates, hard denials, command allowlist\n";

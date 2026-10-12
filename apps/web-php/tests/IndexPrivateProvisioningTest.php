<?php
declare(strict_types=1);

require_once dirname(__DIR__).'/src/IndexPrivateProvisioning.php';
use QSYN\Index\IndexPrivateProvisioning as Draft;

function ensure(bool $ok,string $description):void {
    if(!$ok)throw new RuntimeException('index_prepare_test_failed_'.$description);
}
$root=sys_get_temp_dir().'/qsyn-private-draft-'.bin2hex(random_bytes(8));
ensure(mkdir($root,0700),'make_root');
try {
    ensure(mkdir($root.'/index-history',0700),'make_archive');
    $create=(new ReflectionMethod(Draft::class,'createOnce'));
    $readiness=(new ReflectionMethod(Draft::class,'readiness'));
    $mapping=['schema'=>'QSYN-UPSTOX-INDEX-BOD-MAPPING/1',
        'operator_attested'=>false,'source'=>'candidate_instrument_search_not_attested'];
    $plan=['schema'=>'QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1',
        'operator_approved_display'=>false,'operator_approved_retention'=>false,
        'current_bod_mapping_verified'=>false,'rights_expire_ms'=>0];
    ensure($create->invoke(null,$root,'index-bod-mapping.json',$mapping),'write_mapping');
    ensure($create->invoke(null,$root,'index-worker-plan.json',$plan),'write_plan');
    ensure(!$create->invoke(null,$root,'index-worker-plan.json',['unsafe'=>true]),'no_overwrite');
    $data=json_decode((string)file_get_contents($root.'/index-worker-plan.json'),true);
    ensure($data===$plan,'original_content_unchanged');
    foreach (['index-worker-plan.json','index-bod-mapping.json'] as $file)
        ensure((fileperms($root.'/'.$file)&0077)===0,'file_owner_only_'.$file);
    $report=$readiness->invoke(null,$root);
    ensure($report['plan_prepared']===true,'draft_detected');
    ensure($report['archive_prepared']===true,'archive_detected');
    ensure($report['code']==='INDEX_PLAN_DRAFT_PENDING_INDEPENDENT_APPROVAL','not_licensed');
    ensure(!is_file($root.'/index-rights.json'),'no_fabricated_rights');
    echo "PASS index draft: 0600 files, safe no-overwrite, unapproved state, no rights file\n";
}finally {
    foreach (['index-worker-plan.json','index-bod-mapping.json'] as $file)
        if(file_exists($root.'/'.$file))unlink($root.'/'.$file);
    if(is_dir($root.'/index-history'))rmdir($root.'/index-history');
    if(is_dir($root))rmdir($root);
}

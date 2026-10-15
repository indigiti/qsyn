<?php
declare(strict_types=1);
require_once __DIR__.'/../src/PersonalIndexViewer.php';
use QSYN\MarketData\PersonalIndexViewer;
function checkOwner(bool $value,string $label):void { if (!$value)throw new RuntimeException($label); }
$server=['REQUEST_METHOD'=>'GET','HTTP_HOST'=>'127.0.0.1:18080','REMOTE_ADDR'=>'127.0.0.1'];
putenv('QSYN_ALLOW_HTTP_TEST=1');
putenv('QSYN_TRADING_ENABLED=0');
putenv('QSYN_ENABLE_LIVE_TRADING=0');
putenv('QSYN_PERSONAL_INDEX_OWNER_VIEWER=0');
checkOwner(PersonalIndexViewer::status($server)[0]===403,'disabled_must_deny');
putenv('QSYN_PERSONAL_INDEX_OWNER_VIEWER=1');
putenv('QSYN_PERSONAL_INDEX_OWNER_HOST=127.0.0.1:18080');
putenv('QSYN_PERSONAL_INDEX_OWNER_IP=127.0.0.1');
checkOwner(PersonalIndexViewer::status($server)[0]===200,'pinned_owner_allowed');
$ok=PersonalIndexViewer::accessReport($server);
checkOwner($ok['access_allowed']===true && $ok['code']==='OWNER_VIEWER_ACCESS_READY','owner_preflight_ready');
checkOwner(!isset($ok['ip']) && !isset($ok['host']),'no_private_address_disclosed');
putenv('QSYN_PERSONAL_INDEX_ENABLED=0');
checkOwner(PersonalIndexViewer::status($server)[0]===403,'gateway_disabled_must_not_claim_owner_access');
checkOwner(PersonalIndexViewer::accessReport($server)['code']==='OWNER_INDEX_GATEWAY_DISABLED','gateway_disable_code');
putenv('QSYN_PERSONAL_INDEX_ENABLED=1');
checkOwner(PersonalIndexViewer::accessReport([...$server,'REMOTE_ADDR'=>'127.0.0.2'])['code']
    ==='OWNER_REQUEST_IP_NOT_MATCHED','owner_ip_match_code');
checkOwner(PersonalIndexViewer::accessReport([...$server,'HTTP_HOST'=>'different.test'])['code']
    ==='OWNER_REQUEST_HOST_NOT_MATCHED','owner_host_match_code');

$indexes=PersonalIndexViewer::status($server)[1]['symbols'];
checkOwner(count($indexes)===7 && in_array('SENSEX',$indexes,true),'all_seven_indices');
checkOwner(PersonalIndexViewer::status([...$server,'REMOTE_ADDR'=>'127.0.0.2'])[0]===403,'foreign_ip_denied');
checkOwner(PersonalIndexViewer::status([...$server,'HTTP_HOST'=>'evil.example'])[0]===403,'foreign_host_denied');
checkOwner(PersonalIndexViewer::status([...$server,'REQUEST_METHOD'=>'POST'])[0]===405,'status_read_only');
putenv('QSYN_TRADING_ENABLED=1');
checkOwner(PersonalIndexViewer::status($server)[0]===403,'trading_enabled_denied');
// Opt-in signed browser grants are independent of the IP/hostname, but still
// require a private server-held signing key and a valid owner browser cookie.
$root=sys_get_temp_dir().'/qsyn-owner-browser-'.bin2hex(random_bytes(6));
mkdir($root,0700);chmod($root,0700);
file_put_contents($root.'/owner-index-grant.key',random_bytes(32));
chmod($root.'/owner-index-grant.key',0600);
putenv('QSYN_RUNTIME_DIR='.$root);
putenv('QSYN_PERSONAL_INDEX_OWNER_AUTH=browser_grant');
putenv('QSYN_TRADING_ENABLED=0');
putenv('QSYN_PERSONAL_INDEX_ENABLED=1');
unset($_COOKIE['QSYN_OWNER_INDEX']);
$foreign=[...$server,'REMOTE_ADDR'=>'203.0.113.30','HTTP_HOST'=>'other.example','HTTPS'=>'on'];
checkOwner(PersonalIndexViewer::status($foreign)[0]===403,'missing_browser_grant_denied');
$report=PersonalIndexViewer::accessReport($foreign);
checkOwner($report['code']==='OWNER_BROWSER_GRANT_MISSING_OR_EXPIRED','missing_grant_code');
$expires=time()+3600;
$prefix=$expires.'.'.bin2hex(random_bytes(16));
$signature=hash_hmac('sha256','QSYN-OWNER-INDEX-V1:'.$prefix,
    file_get_contents($root.'/owner-index-grant.key'));
$_COOKIE['QSYN_OWNER_INDEX']=$prefix.'.'.$signature;
checkOwner(PersonalIndexViewer::status($foreign)[0]===200,'valid_browser_grant_allows_changed_ip_host');
checkOwner(PersonalIndexViewer::status($foreign)[1]['access']==='owner-browser-grant','browser_grant_mode');
$_COOKIE['QSYN_OWNER_INDEX']=$prefix.'.'.str_repeat('a',64);
checkOwner(PersonalIndexViewer::status($foreign)[0]===403,'tampered_grant_denied');
$expired=(time()-5).'.'.bin2hex(random_bytes(16));
$_COOKIE['QSYN_OWNER_INDEX']=$expired.'.'.hash_hmac('sha256',
    'QSYN-OWNER-INDEX-V1:'.$expired,file_get_contents($root.'/owner-index-grant.key'));
checkOwner(PersonalIndexViewer::status($foreign)[0]===403,'expired_grant_denied');
$_COOKIE['QSYN_OWNER_INDEX']=$prefix.'.'.$signature;
checkOwner(PersonalIndexViewer::status([...$foreign,'HTTPS'=>'off','HTTP_X_FORWARDED_PROTO'=>''])[0]===403,
    'insecure_transport_denied');
putenv('QSYN_TRADING_ENABLED=1');
checkOwner(PersonalIndexViewer::status($foreign)[0]===403,'trading_mode_browser_denied');
putenv('QSYN_TRADING_ENABLED=0');
unlink($root.'/owner-index-grant.key');rmdir($root);
putenv('QSYN_PERSONAL_INDEX_OWNER_AUTH');
putenv('QSYN_RUNTIME_DIR');
unset($_COOKIE['QSYN_OWNER_INDEX']);

echo "PASS owner-only index viewer, all 7 symbols, denied by default, no trading\n";

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
echo "PASS owner-only index viewer, all 7 symbols, denied by default, no trading\n";

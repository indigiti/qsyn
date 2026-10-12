<?php
declare(strict_types=1);
require_once __DIR__.'/../src/RustAdmin.php';
require_once __DIR__.'/../src/NativeUpstoxAnalyticsApi.php';

use QSYN\Broker\NativeUpstoxAnalyticsApi as Api;

function must(bool $ok, string $label): void {
    if (!$ok) throw new RuntimeException('analytics_test_failed:'.$label);
}
$good=['status'=>'success','data'=>[
    'authorized_redirect_uri'=>'wss://feed-api.upstox.com/market-data-feeder/v3/path?private=one-use'
]];
must(Api::validAuthorization($good),'valid_one_use_wss');
foreach ([
    ['status'=>'error','data'=>$good['data']],
    ['status'=>'success','data'=>['authorized_redirect_uri'=>'https://api.upstox.com/path']],
    ['status'=>'success','data'=>['authorized_redirect_uri'=>'wss://upstox.com.evil.example/path']],
    ['status'=>'success','data'=>['authorized_redirect_uri'=>'wss://user:pass@feed.upstox.com/path']],
    ['status'=>'success','data'=>['authorized_redirect_uri'=>'wss://feed.upstox.com:444/path']],
] as $bad) {
    must(!Api::validAuthorization($bad),'unsafe_wss_rejected');
}
$base=sys_get_temp_dir().'/qsyn-analytics-test-'.bin2hex(random_bytes(8));
must(mkdir($base,0700),'mkdir');
$token='this-is-a-test-only-token-00000000000';
try {
    $calls=0;
    $provider=static function(string $given) use (&$calls,$token): bool {
        $calls++;
        return hash_equals($token,$given);
    };
    must(Api::store($base,'expected-account',$token,$provider),'stored');
    $p=$base.'/upstox-analytics-session.json';
    $s=lstat($p);
    must(($s['mode'] & 0077)===0,'file_is_private');
    $stored=json_decode((string)file_get_contents($p),true,8,JSON_THROW_ON_ERROR);
    must($stored['schema']==='QSYN-UPSTOX-ANALYTICS-SESSION/1','schema');
    must($stored['user_id']==='expected-account','bound_user');
    must($stored['access_token']===$token,'token_persisted_privately');
    $callsAtVerify=0;
    must(Api::verifyStored($base,'expected-account',
        static function(string $value) use (&$callsAtVerify, $token): bool {
            $callsAtVerify++;
            return hash_equals($value, $token);
        })===true,'existing_token_verified');
    must($callsAtVerify===1,'provider_called_once');
    must(Api::verifyStored($base,'other-account',
        static function(string $value): bool { throw new RuntimeException('should_not_call'); }
        )===null,'foreign_identity_rejected_before_provider');
    must(Api::verifyStored($base,'expected-account',
        static fn(string $value): bool=>false)===false,'provider_refusal_reported');
    must(Api::verifyStored($base,'expected-account',
        static function(string $value): bool {
            throw new RuntimeException('upstox_unavailable');
        })===false,'provider_error_sanitized');
    must($stored['order_routing_enabled']===false
        && $stored['display_entitlement_verified']===false
        && $stored['retention_entitlement_verified']===false,'no_rights_claim');
    must(!Api::store($base,'expected-account','too-short',$provider),'short_rejected');
    must(!Api::store($base,'expected-account',$token.' '.chr(10),$provider),'newline_rejected');
    must($calls===1,'invalid_tokens_never_sent_to_provider');
    must(!Api::store($base,'expected-account',str_repeat('Z',64),
        static fn(string $token): bool=>false),'provider_failure_not_stored');
    must(file_get_contents($p)!==false,'previous_valid_token_survives_failed_import');
    must(Api::store($base,'expected-account',$token,$provider),'safe_replacement');
    chmod($p,0644);
    must(Api::verifyStored($base,'expected-account',
        static fn(string $value): bool=>true)===null,'unsafe_file_not_verified');
    $failed=false;
    try { Api::store($base,'expected-account',$token,$provider); }
    catch (Throwable) { $failed=true; }
    must($failed,'unsafe_existing_secret_not_replaced');
    chmod($p,0600);
    echo "PASS analytics token: provider WSS shape, account-binding format, atomic 0600 storage, invalid/revoked inputs\n";
} finally {
    foreach (glob($base.'/*') ?: [] as $file) @unlink($file);
    foreach (glob($base.'/.analytics-*') ?: [] as $file) @unlink($file);
    @rmdir($base);
}

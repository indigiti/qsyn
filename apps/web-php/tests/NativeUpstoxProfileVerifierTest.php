<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/NativeUpstoxProfileVerifier.php';
use QSYN\Broker\NativeUpstoxProfileVerifier as Profile;

$dir = sys_get_temp_dir() . '/qsyn-native-upstox-profile-' . bin2hex(random_bytes(8));
if (!mkdir($dir, 0700)) throw new RuntimeException('cannot_create_test_dir');
$token = str_repeat('T', 80);
$session = [
    'schema' => 'QSYN-UPSTOX-AUTH-SESSION/1',
    'broker' => 'upstox',
    'user_id' => 'UPSTOX123',
    'access_token' => $token,
    'created_at' => gmdate('c'),
    'order_routing_enabled' => false,
    'display_entitlement_verified' => false,
    'retention_entitlement_verified' => false,
];
$file = $dir . '/upstox-session.json';
try {
    file_put_contents($file, json_encode($session, JSON_THROW_ON_ERROR));
    chmod($file, 0600);
    $calls = 0;
    $valid = static function (string $url, string $bearer) use (&$calls, $token): array {
        $calls++;
        if ($url !== 'https://api.upstox.com/v2/user/profile' || $bearer !== $token) {
            throw new RuntimeException('wrong_profile_transport');
        }
        return ['http_status'=>200, 'body'=>['status'=>'success','data'=>[
            'user_id'=>'UPSTOX123', 'is_active'=>true,
            'email'=>'private@example.invalid','exchanges'=>['NSE','BSE']]]];
    };
    $ok = Profile::verify($dir, 'UPSTOX123', $valid);
    if (!$ok['session_verified'] || $ok['status'] !== 'verified_now' || $calls !== 1
        || $ok['index_display_entitlement_verified'] || $ok['index_feed_activated']
        || $ok['trading_enabled'] || str_contains(json_encode($ok), $token)
        || str_contains(json_encode($ok), 'private@example.invalid')) {
        throw new RuntimeException('profile_accepted_or_leaked_unexpectedly');
    }
    $badId = Profile::verify($dir, 'OTHER_USER', $valid);
    if ($badId['session_verified'] || $calls !== 1) {
        throw new RuntimeException('foreign_account_not_blocked');
    }
    $expired = Profile::verify($dir, 'UPSTOX123',
        static fn($url, $token) => ['http_status'=>401, 'body'=>[
            'status'=>'error','errors'=>['token_expired']]]);
    if ($expired['session_verified'] || $expired['status'] !== 'unavailable_or_expired') {
        throw new RuntimeException('expired_token_accepted');
    }
    $inactive = Profile::verify($dir, 'UPSTOX123',
        static fn($url,$token) => ['http_status'=>200, 'body'=>[
            'status'=>'success','data'=>['user_id'=>'UPSTOX123','is_active'=>false]]]);
    if ($inactive['session_verified']) throw new RuntimeException('inactive_profile_accepted');
    $other = Profile::verify($dir, 'UPSTOX123',
        static fn($url,$token) => ['http_status'=>200,'body'=>[
            'status'=>'success','data'=>['user_id'=>'ANOTHER','is_active'=>true]]]);
    if ($other['session_verified']) throw new RuntimeException('wrong_profile_accepted');
    chmod($file, 0644);
    if (Profile::verify($dir,'UPSTOX123',$valid)['session_verified'] || $calls!==1) {
        throw new RuntimeException('unsafe_file_permissions_accepted');
    }
    chmod($file, 0600);
    unlink($file);
    if (Profile::verify($dir,'UPSTOX123',$valid)['session_verified']) {
        throw new RuntimeException('absent_token_accepted');
    }
    echo "PASS native Upstox profile: expected identity, active, expiry, 0600, sanitized result, no exchange rights\n";
} finally {
    if (is_file($file)) unlink($file);
    rmdir($dir);
}

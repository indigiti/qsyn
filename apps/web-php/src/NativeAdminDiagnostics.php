<?php
declare(strict_types=1);

namespace QSYN\Diagnostics;

use QSYN\Admin\RustAdmin;

/**
 * Redacted diagnostic surface, usable only with the QSYN administrator
 * password. Never probes Upstox using a saved bearer or reads OAuth secrets.
 */
final class NativeAdminDiagnostics
{
    /** @return array{0:int,1:array<string,mixed>} */
    public static function read(array $server): array
    {
        $requestId = bin2hex(random_bytes(8));
        if (($server['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            return [405, ['error' => 'method_not_allowed', 'request_id'=>$requestId]];
        }
        if (!RustAdmin::originAllowed($server)) {
            return [403, ['error' => 'secure_same_origin_required','request_id'=>$requestId]];
        }
        RustAdmin::boot();
        if (!RustAdmin::authenticated()) {
            return [401, [
                'error'=>'admin_login_required',
                'diagnostic_code'=>'ADMIN_REAUTH_REQUIRED',
                'request_id'=>$requestId,
            ]];
        }
        $session = RustAdmin::sessionReport();
        $runtime = (string)(getenv('QSYN_RUNTIME_DIR')
            ?: dirname(__DIR__, 2) . '/runtime');
        $privateDirectory = $runtime . '/upstox-private';
        $privateOk = self::privateDirectory($privateDirectory);
        $app = $privateOk ? self::privateFile($privateDirectory.'/upstox-app.json') : false;
        $token = $privateOk ? self::privateFile($privateDirectory.'/upstox-session.json') : false;
        $workerBinary = dirname(__DIR__) . '/bin/qsyn-upstox-index-worker';
        $workerPackaged = is_file($workerBinary) && !is_link($workerBinary);
        $items=[
            ['component'=>'admin_session',
                'status'=>'ok', 'code'=>'ADMIN_SESSION_VALID'],
            ['component'=>'upstox_configuration',
                'status'=>$app?'ok':'unavailable',
                'code'=>$app?'UPSTOX_CONFIG_PRIVATE_PRESENT':'UPSTOX_CONFIG_NOT_READABLE'],
            ['component'=>'upstox_token_file',
                'status'=>$token?'present_unverified':'unavailable',
                'code'=>$token?'UPSTOX_TOKEN_PRIVATE_PRESENT':'UPSTOX_TOKEN_NOT_READABLE'],
            ['component'=>'upstox_profile',
                'status'=>'not_checked',
                'code'=>'UPSTOX_PROFILE_CHECK_ON_DEMAND'],
            ['component'=>'index_worker_binary',
                'status'=>$workerPackaged?'packaged_not_running_verified':'not_packaged',
                'code'=>$workerPackaged?'RUST_INDEX_BINARY_PACKAGED':'RUST_INDEX_BINARY_NOT_FOUND'],
            ['component'=>'index_market_data',
                'status'=>'not_verified',
                'code'=>'INDEX_ENTITLEMENT_AND_FEED_NOT_ATTESTED'],
        ];
        return [200,[
            'schema'=>'QSYN-ADMIN-DIAGNOSTICS/1',
            'request_id'=>$requestId,
            'checked_at_utc'=>gmdate('c'),
            'admin'=>[
                'authenticated'=>true,
                'idle_remaining_seconds'=>$session['idle_remaining_seconds'],
                'cookie_received'=>$session['cookie_received'],
                'session_storage_active'=>$session['session_storage_active'],
                'cookie_secure_expected'=>$session['cookie_secure_expected'],
                'cookie_path'=>$session['cookie_path'],
                'reason_code'=>$session['reason_code'],
            ],
            'components'=>$items,
            'trading_enabled'=>false,
            'live_index_feed_verified'=>false,
            'notes'=>[
                'A private token file is not a live Upstox provider session.',
                'A packaged index worker is not evidence of a running service.',
                'Browser diagnostics do not reveal or test exchange licenses.',
            ],
        ]];
    }

    private static function privateDirectory(string $path): bool
    {
        $stat=@lstat($path);
        return $stat !== false && is_dir($path) && !is_link($path)
            && ($stat['mode'] & 0077) === 0
            && (!function_exists('posix_geteuid') || $stat['uid'] === posix_geteuid());
    }
    private static function privateFile(string $path): bool
    {
        $stat=@lstat($path);
        return $stat !== false && is_file($path) && !is_link($path)
            && ($stat['mode'] & 0077) === 0 && $stat['size'] > 0
            && (!function_exists('posix_geteuid') || $stat['uid'] === posix_geteuid());
    }
}

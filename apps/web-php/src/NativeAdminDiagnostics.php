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
        // Read-only evidence of private file presence. These are NOT
        // authorization/entitlement or live-stream checks and must never
        // expose the bearer, mapped instrument list, account ID or paths.
        $analytics = $privateOk
            ? self::privateFile($privateDirectory.'/upstox-analytics-session.json')
            : false;
        $planPath = getenv('QSYN_UPSTOX_INDEX_WORKER_PLAN_FILE');
        $planAdvertised = is_string($planPath) && $planPath !== '';
        $planPrivate = $planAdvertised
            && str_starts_with($planPath, '/')
            && !str_contains($planPath, '/..')
            && !is_link($planPath)
            && self::privateFile($planPath)
            && (int)@filesize($planPath) <= 8192;
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
            ['component'=>'upstox_analytics_token_file',
                'status'=>$analytics?'present_unverified':'unavailable',
                'code'=>$analytics?'UPSTOX_ANALYTICS_PRIVATE_PRESENT':'UPSTOX_ANALYTICS_PRIVATE_NOT_READABLE'],
            ['component'=>'index_worker_plan',
                'status'=>$planPrivate?'present_unverified':($planAdvertised?'invalid_or_unreadable':'not_configured'),
                'code'=>$planPrivate?'INDEX_OPERATOR_PLAN_PRIVATE_PRESENT_NOT_VALIDATED':
                    ($planAdvertised?'INDEX_OPERATOR_PLAN_NOT_PRIVATE':'INDEX_OPERATOR_PLAN_NOT_CONFIGURED')],
            ['component'=>'index_bod_mapping_and_rights',
                'status'=>'operator_preflight_required',
                'code'=>'INDEX_BOD_RIGHTS_REQUIRE_RUST_PREFLIGHT'],
            ['component'=>'index_worker_runtime',
                'status'=>'not_checked',
                'code'=>'INDEX_WORKER_PROCESS_NOT_VERIFIED'],
            ['component'=>'index_chart_websocket',
                'status'=>'not_checked',
                'code'=>'INDEX_PRIVATE_WSS_NOT_VERIFIED'],
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
            'index_activation'=>[
                'schema'=>'QSYN-INDEX-ACTIVATION-PREFLIGHT/1',
                'provider_token_verified_by_report'=>false,
                'private_analytics_token_file_present'=>$analytics,
                'operator_plan_advertised'=>$planAdvertised,
                'operator_plan_private_file_present'=>$planPrivate,
                'bod_mapping_verified_now'=>false,
                'display_rights_verified_now'=>false,
                'worker_process_verified_now'=>false,
                'private_wss_verified_now'=>false,
                'live_index_prices_verified_now'=>false,
                'next_action_code'=>$planPrivate
                    ? 'OPERATOR_RUN_INDEX_WORKER_CHECK'
                    : 'OPERATOR_PROVISION_INDEX_WORKER_PLAN',
                'trading_enabled'=>false,
            ],
            'notes'=>[
                'A private token file is not a live Upstox provider session.',
                'A packaged index worker is not evidence of a running service.',
                'Browser diagnostics do not reveal or test exchange licenses.',
                'A stored Analytics Token can be reverified separately in Brokers without exposing it.',
                'Operator must run the Rust worker check against a current, approved private plan before any activation.',
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

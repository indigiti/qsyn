<?php
declare(strict_types=1);

namespace QSYN\Index;

use QSYN\Admin\RustAdmin;
use QSYN\Broker\NativeUpstoxIndexDiscovery;

/**
 * Browser-managed PREPARATION only. Creates owner-only inactive index plan and
 * candidate mapping inside the same pre-existing private runtime as Upstox tokens.
 * Does not attest official BOD, account identity, exchange rights or retention.
 */
final class IndexPrivateProvisioning
{
    private const SCHEMA = 'QSYN-INDEX-PRIVATE-PROVISIONING/1';
    private const EXPECTED = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','INDIAVIX','SENSEX'];

    private static function secureDir(string $path, bool $owner = true): bool
    {
        $real = realpath($path);
        $stat = @lstat($path);
        return $path !== '/' && $real !== false && $real === $path
            && is_dir($path) && !is_link($path) && $stat !== false
            && ($stat['mode'] & ($owner ? 0077 : 0002)) === 0
            && (!$owner || !function_exists('posix_geteuid')
                || $stat['uid'] === posix_geteuid());
    }

    private static function privateFile(string $path, int $max): bool
    {
        clearstatcache(true, $path);
        $stat = @lstat($path);
        return $stat !== false && is_file($path) && !is_link($path)
            && ($stat['mode'] & 0077) === 0
            && $stat['size'] > 8 && $stat['size'] <= $max
            && (!function_exists('posix_geteuid') || $stat['uid'] === posix_geteuid());
    }

    private static function root(bool $create): ?string
    {
        $runtime = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2).'/runtime');
        if ($runtime === '' || !str_starts_with($runtime,'/')
            || str_contains($runtime,'/..') || str_contains($runtime,'//')
            || preg_match('~/(?:public_html|webroot|www)(?:/|$)~i',$runtime)
            || !self::secureDir($runtime,false)) return null;
        $root = $runtime.'/upstox-private';
        if (!is_dir($root) && $create && !is_link($root)) {
            $mask=umask(0077);
            try { @mkdir($root,0700); } finally { umask($mask); }
        }
        return self::secureDir($root) ? $root : null;
    }

    private static function expectedUser(string $root): ?string
    {
        $expected=getenv('QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID');
        if (!is_string($expected) || $expected==='') {
            $path=$root.'/upstox-app.json';
            if (self::privateFile($path,2048)) {
                $data=json_decode((string)@file_get_contents($path),true);
                if (($data['schema']??null)==='QSYN-UPSTOX-WEB-APP/1')
                    $expected=$data['expected_user_id']??null;
            }
        }
        return is_string($expected)
            && preg_match('/\A[A-Za-z0-9_.@-]{2,128}\z/D',$expected) ? $expected : null;
    }

    private static function readiness(?string $root): array
    {
        if ($root===null) return ['private_storage_ready'=>false,
            'plan_prepared'=>false,'archive_prepared'=>false,'account_binding_ready'=>false,
            'code'=>'INDEX_PRIVATE_RUNTIME_UNAVAILABLE'];
        $plan=$root.'/index-worker-plan.json';
        $mapping=$root.'/index-bod-mapping.json';
        $ready=self::privateFile($plan,8192);
        $prepared=false;
        if ($ready) {
            $record=json_decode((string)@file_get_contents($plan),true);
            $prepared=is_array($record)
                && ($record['schema']??'')==='QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1'
                && ($record['operator_approved_display']??true)===false
                && ($record['operator_approved_retention']??true)===false
                && ($record['current_bod_mapping_verified']??true)===false
                && ($record['rights_expire_ms']??-1)===0;
        }
        $mapped=self::privateFile($mapping,8192);
        $archive=self::secureDir($root.'/index-history');
        return [
            'private_storage_ready'=>true,
            'plan_prepared'=>$prepared && $mapped,
            'plan_file_present'=>$ready,
            'mapping_file_present'=>$mapped,
            'archive_prepared'=>$archive,
            'account_binding_ready'=>self::expectedUser($root)!==null,
            'code'=>$prepared && $mapped
                ? 'INDEX_PLAN_DRAFT_PENDING_INDEPENDENT_APPROVAL'
                : ($ready?'INDEX_EXISTING_PRIVATE_PLAN_NOT_MODIFIED'
                    :'INDEX_PRIVATE_PLAN_PREPARATION_AVAILABLE'),
        ];
    }

    private static function makeDir(string $path): bool
    {
        if (is_link($path)) return false;
        if (!is_dir($path)) {
            $mask=umask(0077);
            try { if (!@mkdir($path,0700)) return false; }
            finally { umask($mask); }
        }
        return self::secureDir($path);
    }

    private static function createOnce(string $dir, string $name, array $contents): bool
    {
        $path=$dir.'/'.$name;
        if (file_exists($path) || is_link($path)) return false;
        $json=json_encode($contents,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
        if (strlen($json)>8192) return false;
        $mask=umask(0077);
        try { $fp=@fopen($path,'x'); } finally { umask($mask); }
        if (!$fp) return false;
        try {
            if (!@chmod($path,0600) || fwrite($fp,$json)!==strlen($json)
                || !fflush($fp)) {
                @unlink($path);return false;
            }
        } finally { fclose($fp); }
        return self::privateFile($path,8192);
    }

    public static function dispatch(string $action, array $server,
        ?callable $discover = null): array
    {
        if (!in_array($action,['status','prepare'],true)) return [404,['error'=>'not_found']];
        if (($server['REQUEST_METHOD']??'GET')!==($action==='status'?'GET':'POST'))
            return [405,['error'=>'method_not_allowed']];
        if (!RustAdmin::originAllowed($server))
            return [403,['error'=>'secure_same_origin_required']];
        RustAdmin::boot();
        if (!RustAdmin::authenticated()) return [401,['error'=>'admin_login_required']];
        if (getenv('QSYN_TRADING_ENABLED')==='1' || getenv('QSYN_ENABLE_LIVE_TRADING')==='1'
            || getenv('QSYN_INDEX_PRIVATE_PREPARE_ENABLED')==='0')
            return [503,['error'=>'index_private_preparation_disabled']];
        $root=self::root(false);
        if ($action==='status') return [200,[
            'schema'=>self::SCHEMA,'csrf'=>RustAdmin::csrf(),
            ...self::readiness($root),
            'independent_bod_attested'=>false,'rights_approved_by_browser'=>false,
            'live_feed_activated'=>false,'trading_enabled'=>false]];
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,['error'=>'csrf_invalid']];
        if (!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))
            return [415,['error'=>'json_required']];
        $raw=file_get_contents('php://input',false,null,0,1025);
        if (!is_string($raw)||strlen($raw)>1024) return [413,['error'=>'request_too_large']];
        try { $body=json_decode($raw,true,4,JSON_THROW_ON_ERROR); }
        catch (\Throwable) { return [400,['error'=>'invalid_json']]; }
        if (!is_array($body)||array_is_list($body)||count($body)!==4
            || ($body['confirmed']??null)!==true) return [422,['error'=>'invalid_request']];
        foreach (['tenant','account','owner'] as $key) {
            if (!is_string($body[$key]??null)
                || !preg_match('/\A[A-Za-z0-9_.:-]{2,80}\z/D',$body[$key]))
                return [422,['error'=>'invalid_private_scope_alias']];
        }
        // Never shadow an operator-configured external plan/archive path.
        if (getenv('QSYN_UPSTOX_INDEX_WORKER_PLAN_FILE')
            || getenv('QSYN_INDEX_WEB_ARCHIVE_ROOT'))
            return [409,['error'=>'index_external_paths_require_host_review']];
        $root=self::root(true);
        if ($root===null) return [503,['error'=>'index_private_runtime_unavailable']];
        $user=self::expectedUser($root);
        if ($user===null) return [409,['error'=>'upstox_account_binding_required']];
        $bearer=self::privateFile($root.'/upstox-analytics-session.json',16384)
            ? $root.'/upstox-analytics-session.json'
            : (self::privateFile($root.'/upstox-session.json',16384)
                ? $root.'/upstox-session.json' : null);
        if ($bearer===null) return [409,['error'=>'upstox_private_session_required']];
        // Discovery is performed afresh on the server. The browser cannot submit
        // instrument keys, official-BOD claims, rights or executable paths.
        $result=$discover ? $discover($root,$user)
            : NativeUpstoxIndexDiscovery::discover($root,$user);
        if (($result['mapping_fully_resolved']??false)!==true
            || count($result['instruments']??[])!==6)
            return [409,['error'=>'index_discovery_not_resolved']];
        $instruments=[];
        foreach ($result['instruments'] as $entry) {
            if (($entry['status']??null)!=='resolved'
                || !in_array($entry['symbol']??null,self::EXPECTED,true)
                || !in_array($entry['exchange']??null,['NSE_INDEX','BSE_INDEX'],true)
                || !is_string($entry['instrument_key']??null)
                || !preg_match('/\A(?:NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9 ._-]{1,100}\z/D',
                    $entry['instrument_key'])
                || !str_starts_with($entry['instrument_key'],$entry['exchange'].'|'))
                return [409,['error'=>'index_discovery_invalid']];
            $instruments[]=['exchange'=>$entry['exchange'],
                'symbol'=>$entry['symbol'],'instrument_key'=>$entry['instrument_key']];
        }
        if (count(array_unique(array_column($instruments,'symbol')))!==6)
            return [409,['error'=>'index_discovery_duplicate']];
        // Reject a pre-existing link before opening the lock path.
        if (is_link($root.'/.index-prepare.lock'))
            return [409,['error'=>'index_preparation_lock_unsafe']];
        $mask=umask(0077);
        try { $lock=@fopen($root.'/.index-prepare.lock','c'); }
        finally { umask($mask); }
        if (!$lock||!flock($lock,LOCK_EX|LOCK_NB)) {
            if ($lock) fclose($lock);
            return [409,['error'=>'index_preparation_in_progress']];
        }
        try {
            if (is_link($root.'/.index-prepare.lock')
                || (fileperms($root.'/.index-prepare.lock') & 0077)!==0)
                return [409,['error'=>'index_preparation_lock_unsafe']];
            if (file_exists($root.'/index-worker-plan.json')
                || is_link($root.'/index-worker-plan.json')
                || file_exists($root.'/index-bod-mapping.json')
                || is_link($root.'/index-bod-mapping.json'))
                return [409,['error'=>'index_private_files_already_exist']];
            foreach (['index-history','index-wal','charts'] as $dir)
                if (!self::makeDir($root.'/'.$dir))
                    return [503,['error'=>'index_private_directory_unavailable']];
            $mapping=[
                'schema'=>'QSYN-UPSTOX-INDEX-BOD-MAPPING/1',
                'tenant'=>$body['tenant'],'account'=>$body['account'],
                'owner'=>$body['owner'],'upstox_user_id'=>$user,
                'source'=>'candidate_instrument_search_not_attested',
                'checked_at_ms'=>(int)round(microtime(true)*1000),
                'bod_date_ist'=>(new \DateTimeImmutable('now',new \DateTimeZone('Asia/Kolkata')))->format('Y-m-d'),
                'operator_attested'=>false,'instruments'=>$instruments,
            ];
            $plan=[
                'schema'=>'QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1',
                'tenant'=>$body['tenant'],'account'=>$body['account'],
                'owner'=>$body['owner'],'upstox_user_id'=>$user,
                'entitlement_id'=>'UNAPPROVED',
                'instruments'=>$instruments,'rights_expire_ms'=>0,
                'wal_root'=>$root.'/index-wal',
                'private_chart_socket'=>$root.'/charts/index.ipc',
                'private_rights_file'=>$root.'/index-rights.json',
                'private_oauth_session_file'=>$bearer,
                'private_index_mapping_file'=>$root.'/index-bod-mapping.json',
                'operator_approved_display'=>false,'operator_approved_retention'=>false,
                'current_bod_mapping_verified'=>false,'max_attempts'=>3,
            ];
            if (!self::createOnce($root,'index-bod-mapping.json',$mapping))
                return [503,['error'=>'index_mapping_draft_write_failed']];
            if (!self::createOnce($root,'index-worker-plan.json',$plan))
                return [503,['error'=>'index_plan_draft_write_failed']];
            return [201,[
                'schema'=>self::SCHEMA,'code'=>'INDEX_PRIVATE_DRAFT_PREPARED_NO_RIGHTS',
                ...self::readiness($root),
                'approved_instrument_count'=>0,'candidate_instrument_count'=>6,
                'feed_activated'=>false,'trading_enabled'=>false]];
        } finally {
            flock($lock,LOCK_UN);fclose($lock);
        }
    }
}

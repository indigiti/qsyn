<?php
declare(strict_types=1);

namespace QSYN\Index;

use QSYN\Admin\RustAdmin;

/**
 * Bounded web operator interface to the EXISTING Rust executable and a
 * dedicated, operator-provisioned Supervisor. Never a generic shell.
 *
 * An admin login by itself NEVER authorizes a feed, shell process or account.
 * Host operator must opt in, supply private paths and approved rights.
 */
final class IndexWebOperations
{
    private const SCHEMA = 'QSYN-INDEX-WEB-OPERATIONS/1';
    private const ACTIONS = ['status', 'check', 'backfill', 'start', 'stop'];
    private const HISTORY_SCHEMA = 'QSYN-UPSTOX-PRIVATE-INDEX-IMPORT/1';

    private static function privatePath(string $path, bool $directory, int $max = 65536): bool
    {
        if ($path === '' || !str_starts_with($path, '/') || str_contains($path, '/..')
            || str_contains($path, '//') || is_link($path)) return false;
        $stat = @lstat($path);
        if (!is_array($stat) || ($stat['mode'] & 0007) !== 0
            || ($directory ? !is_dir($path) : !is_file($path))
            || (!$directory && (($stat['mode'] & 0077) !== 0
                || $stat['size'] < 10 || $stat['size'] > $max))
            || (function_exists('posix_geteuid')
                && $stat['uid'] !== posix_geteuid())) return false;
        return $directory ? (($stat['mode'] & 0077) === 0) : true;
    }

    private static function settings(): array
    {
        $plan = (string)(getenv('QSYN_UPSTOX_INDEX_WORKER_PLAN_FILE') ?: '');
        $archive = (string)(getenv('QSYN_INDEX_WEB_ARCHIVE_ROOT') ?: '');
        $bin = dirname(__DIR__) . '/bin';
        $worker = $bin . '/qsyn-upstox-index-worker';
        $history = $bin . '/qsyn-upstox-index-history';
        $planOk = self::privatePath($plan, false);
        $archiveOk = self::privatePath($archive, true);
        $binaryOk = is_file($worker) && is_executable($worker) && !is_link($worker)
            && is_file($history) && is_executable($history) && !is_link($history);
        $readOnly = getenv('QSYN_INDEX_WEB_OPERATIONS_ENABLED') !== '0'
            && getenv('QSYN_TRADING_ENABLED') !== '1'
            && getenv('QSYN_ENABLE_LIVE_TRADING') !== '1';
        $enabled = $readOnly
            && getenv('QSYN_INDEX_WEB_OPERATIONS_ENABLED') === '1';
        $supervisor = (string)(getenv('QSYN_INDEX_WEB_SUPERVISOR_CONFIG') ?: '');
        $ctl = (string)(getenv('QSYN_SUPERVISORCTL_BIN') ?: '/usr/bin/supervisorctl');
        $supervisorOk = $enabled
            && getenv('QSYN_INDEX_WEB_SERVICE_CONTROL_ENABLED') === '1'
            && self::privatePath($supervisor, false)
            && in_array($ctl, ['/usr/bin/supervisorctl', '/usr/local/bin/supervisorctl'], true)
            && is_file($ctl) && is_executable($ctl)
            && self::supervisorProgram('worker') !== null
            && self::supervisorProgram('history') !== null;
        return compact('plan','archive','worker','history','planOk','archiveOk',
            'binaryOk','enabled','supervisor','ctl','supervisorOk') + [
            'preflightOk'=>$readOnly && $planOk && $archiveOk && $binaryOk,
            'backfillOk'=>$enabled && getenv('QSYN_INDEX_WEB_BACKFILL_ENABLED') === '1'
                && getenv('QSYN_UPSTOX_INDEX_HISTORY_ENABLE') === '1'
        ];
    }

    private static function supervisorProgram(string $kind): ?string
    {
        $key = $kind === 'worker' ? 'QSYN_INDEX_WEB_WORKER_PROGRAM'
            : 'QSYN_INDEX_WEB_HISTORY_PROGRAM';
        $program = (string)(getenv($key) ?: '');
        return preg_match('/\Aqsyn-upstox-v3-index(?:-history)?-[A-Za-z0-9_-]{2,64}\z/D', $program)
            && ($kind === 'worker'
                ? str_starts_with($program,'qsyn-upstox-v3-index-')
                    && !str_starts_with($program,'qsyn-upstox-v3-index-history-')
                : str_starts_with($program,'qsyn-upstox-v3-index-history-'))
            ? $program : null;
    }

    /** Date never becomes a command. Only an existing IST trading day ≤30d old. */
    public static function validDay(string $date, ?\DateTimeImmutable $now = null): bool
    {
        if (!preg_match('/\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z/D', $date)) return false;
        $tz = new \DateTimeZone('Asia/Kolkata');
        $day = \DateTimeImmutable::createFromFormat('!Y-m-d', $date, $tz);
        if (!$day || $day->format('Y-m-d') !== $date) return false;
        $today = ($now ?? new \DateTimeImmutable('now', $tz))->setTimezone($tz)
            ->setTime(0, 0);
        $weekday = (int)$day->format('N');
        return $day < $today && $day >= $today->modify('-30 days') && $weekday <= 5;
    }

    private static function lock(string $plan)
    {
        $dir = dirname($plan);
        if (!self::privatePath($dir, true)) return null;
        $file = $dir . '/.qsyn-index-web.lock';
        if (is_link($file)) return null;
        $mask=umask(0077);
        try { $handle=@fopen($file,'c'); } finally { umask($mask); }
        if (!$handle) return null;
        $stat=@lstat($file);
        if (!$stat || ($stat['mode'] & 0077) !== 0
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())
            || !flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);
            return null;
        }
        return $handle;
    }

    private static function invoke(array $command, float $seconds, int $maxOut = 32768): array
    {
        if (!function_exists('proc_open') || !function_exists('proc_get_status')
            || !function_exists('proc_terminate')) {
            return ['ok'=>false,'code'=>'INDEX_WEB_EXECUTOR_UNAVAILABLE','output'=>''];
        }
        $pipes=[];
        $process=@proc_open($command, [
            0=>['pipe','r'], 1=>['pipe','w'], 2=>['pipe','w']
        ], $pipes, null, null, ['bypass_shell'=>true]);
        if (!is_resource($process)) {
            return ['ok'=>false,'code'=>'INDEX_WEB_EXECUTOR_UNAVAILABLE','output'=>''];
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1],false); stream_set_blocking($pipes[2],false);
        $output=''; $deadline=microtime(true)+$seconds;
        $statusCode=-1; $timeout=false; $oversize=false;
        try {
            do {
                $chunk=(string)stream_get_contents($pipes[1],4096);
                $output.=$chunk;
                // Provider and Rust stderr may contain confidential details.
                stream_get_contents($pipes[2],4096);
                if (strlen($output)>$maxOut) {
                    $oversize=true; proc_terminate($process); break;
                }
                $state=proc_get_status($process);
                if (!$state['running']) {
                    $statusCode=(int)$state['exitcode']; break;
                }
                if (microtime(true)>=$deadline) {
                    $timeout=true; proc_terminate($process); break;
                }
                usleep(30000);
            } while(true);
        } finally {
            fclose($pipes[1]); fclose($pipes[2]); proc_close($process);
        }
        return ['ok'=>!$timeout && !$oversize && $statusCode===0,
            'code'=>$timeout?'INDEX_OPERATION_TIMED_OUT':
                ($oversize?'INDEX_OPERATION_OUTPUT_LIMIT':
                ($statusCode===0?'INDEX_COMMAND_COMPLETED':'INDEX_COMMAND_REJECTED')),
            'output'=>$output];
    }

    private static function runCheck(array $settings, string $day): array
    {
        $w=self::invoke([$settings['worker'],'check',$settings['plan']],4);
        if (!$w['ok']) return ['ok'=>false,'code'=>'INDEX_WORKER_PREFLIGHT_REJECTED'];
        $h=self::invoke([$settings['history'],'check-all',
            $settings['plan'],$settings['archive'],$day],5);
        if (!$h['ok']) return ['ok'=>false,'code'=>'INDEX_HISTORY_PREFLIGHT_REJECTED'];
        $report=json_decode(trim($h['output']),true);
        if (!is_array($report)
            || ($report['schema']??'')!=='QSYN-UPSTOX-INDEX-HISTORY-BATCH-PREFLIGHT/1'
            || !is_int($report['approved_instrument_count']??null)
            || $report['approved_instrument_count']<1
            || $report['approved_instrument_count']>8
            || ($report['trading_enabled']??true)!==false) {
            return ['ok'=>false,'code'=>'INDEX_PREFLIGHT_RESPONSE_INVALID'];
        }
        return ['ok'=>true,'code'=>'INDEX_PLAN_VALIDATED_NO_FEED_STARTED',
            'approved_instrument_count'=>$report['approved_instrument_count']];
    }

    private static function supervisorAction(array $s, string $kind, string $operation): array
    {
        if (!$s['supervisorOk']) return ['ok'=>false,'code'=>'INDEX_SUPERVISOR_NOT_PROVISIONED'];
        $program=self::supervisorProgram($kind);
        if ($program===null) return ['ok'=>false,'code'=>'INDEX_SERVICE_NAME_INVALID'];
        $result=self::invoke([$s['ctl'],'-c',$s['supervisor'],$operation,$program],6,8192);
        if ($operation==='status') {
            if (!$result['ok']) return ['ok'=>false,'state'=>'unavailable'];
            $resultText=strtoupper(trim($result['output']));
            $escaped=preg_quote(strtoupper($program),'/');
            if (!preg_match('/\A'.$escaped.'\s+(RUNNING|STOPPED|STARTING|STOPPING|FATAL|BACKOFF|EXITED)\b/', $resultText,$matches))
                return ['ok'=>false,'state'=>'unknown'];
            return ['ok'=>true,'state'=>strtolower($matches[1])];
        }
        return ['ok'=>$result['ok'],
            'code'=>$result['ok']?'INDEX_SERVICE_COMMAND_ACCEPTED':'INDEX_SERVICE_COMMAND_REJECTED'];
    }

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(string $action, array $server): array
    {
        if (!in_array($action,self::ACTIONS,true)) return [404,['error'=>'not_found']];
        $method=$action==='status'?'GET':'POST';
        if (($server['REQUEST_METHOD']??'GET')!==$method)
            return [405,['error'=>'method_not_allowed']];
        if (!RustAdmin::originAllowed($server))
            return [403,['error'=>'secure_same_origin_required']];
        RustAdmin::boot();
        if (!RustAdmin::authenticated())
            return [401,['error'=>'admin_login_required']];
        $s=self::settings();
        if ($action==='status') {
            $state=['worker'=>'not_checked','history'=>'not_checked'];
            if ($s['supervisorOk']) foreach (['worker','history'] as $name) {
                $state[$name]=self::supervisorAction($s,$name,'status')['state']??'unknown';
            }
            return [200,[
                'schema'=>self::SCHEMA,'csrf'=>RustAdmin::csrf(),
                'web_operations_enabled'=>$s['enabled'],
                'preflight_enabled'=>$s['preflightOk'],
                'private_plan_ready'=>$s['planOk'],'archive_ready'=>$s['archiveOk'],
                'rust_binary_ready'=>$s['binaryOk'],
                'backfill_enabled'=>$s['backfillOk'],
                'service_controls_enabled'=>$s['supervisorOk'],
                'services'=>$state,'trading_enabled'=>false,
                'rights_verified_by_browser'=>false,
                'live_index_prices_verified'=>false
            ]];
        }
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,['error'=>'csrf_invalid']];
        if (!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))
            return [415,['error'=>'json_required']];
        $raw=file_get_contents('php://input',false,null,0,512);
        if (!is_string($raw) || strlen($raw)>511)
            return [413,['error'=>'request_too_large']];
        try{$body=json_decode($raw,true,5,JSON_THROW_ON_ERROR);}
        catch(\Throwable){return [400,['error'=>'invalid_json']];}
        if (!is_array($body) || array_is_list($body)
            || ($body['confirmed']??null)!==true)
            return [422,['error'=>'explicit_confirmation_required']];
        if (!$s['preflightOk'] || ($action!=='check' && !$s['enabled']))
            return [503,['error'=>'index_web_operator_not_provisioned']];
        $date=$body['date']??null;
        if (!is_string($date) || !self::validDay($date))
            return [422,['error'=>'invalid_completed_trading_date']];
        if ($action==='start'||$action==='stop') {
            if (count($body)!==3 || !in_array($body['service']??null,['worker','history'],true))
                return [422,['error'=>'invalid_service_selection']];
            if (!$s['supervisorOk'])
                return [503,['error'=>'index_supervisor_not_provisioned']];
        } elseif ($action==='backfill') {
            if (count($body)!==3 || !is_int($body['step']??null)
                || $body['step']<0 || $body['step']>7)
                return [422,['error'=>'invalid_index_step']];
        } elseif (count($body)!==2) {
            return [422,['error'=>'invalid_operation_parameters']];
        }
        if ($action==='backfill' && !$s['backfillOk'])
            return [503,['error'=>'index_backfill_not_authorized']];
        $lock=self::lock($s['plan']);
        if (!$lock)return [409,['error'=>'index_operation_already_running_or_unavailable']];
        // Do not hold the PHP session lock across a bounded Rust command.
        session_write_close();
        try {
            $checked=$action==='stop' ? ['ok'=>true] : self::runCheck($s,$date);
            if (!$checked['ok']) return [409,[
                'schema'=>self::SCHEMA,'error'=>$checked['code'],
                'live_index_prices_verified'=>false
            ]];
            if ($action==='check') {
                return [200,[
                    'schema'=>self::SCHEMA,'result_code'=>$checked['code'],
                    'approved_instrument_count'=>$checked['approved_instrument_count'],
                    'history_imported'=>false,'feed_activated'=>false,'trading_enabled'=>false
                ]];
            }
            if ($action==='backfill') {
                $ordinal=$body['step'];
                if ($ordinal >= $checked['approved_instrument_count'])
                    return [422,['error'=>'index_step_not_approved']];
                // Never accept an instrument key from HTTP. Select an
                // ordinal from the already Rust-validated owner-only plan,
                // then let the Rust one-index CLI revalidate rights again.
                $record=json_decode((string)@file_get_contents($s['plan']),true,16);
                $instruments=is_array($record) ? ($record['instruments']??null) : null;
                if (!is_array($instruments)
                    || count($instruments)!==$checked['approved_instrument_count']
                    || !is_array($instruments[$ordinal]??null))
                    return [409,['error'=>'index_private_plan_changed']];
                $key=$instruments[$ordinal]['instrument_key']??null;
                if (!is_string($key)
                    || !preg_match('/\A(?:NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9 ._-]{1,100}\z/D',$key))
                    return [409,['error'=>'index_private_key_invalid']];
                $run=self::invoke([$s['history'],'backfill',
                    $s['plan'],$s['archive'],$key,$date],17,8192);
                $data=$run['ok']?json_decode(trim($run['output']),true):null;
                if (!$run['ok'] || !is_array($data)
                    || ($data['schema']??'')!==self::HISTORY_SCHEMA
                    || ($data['instrument']??'')!==$key
                    || ($data['source']??'')!=='upstox_v3_private_index_history'
                    || !is_int($data['candle_count']??null)
                    || $data['candle_count']<0 || $data['candle_count']>2000
                    || ($data['public_redistribution_allowed']??true)!==false
                    || ($data['execution_enabled']??true)!==false)
                    return [502,['schema'=>self::SCHEMA,
                        'error'=>'INDEX_HISTORY_STEP_FAILED_OR_INCOMPLETE']];
                return [200,['schema'=>self::SCHEMA,
                    'result_code'=>'INDEX_HISTORY_STEP_COMPLETED',
                    'approved_instrument_count'=>$checked['approved_instrument_count'],
                    'step'=>$ordinal,'next_step'=>$ordinal+1,
                    'candle_count'=>$data['candle_count'],
                    'archive_written'=>$data['archive_written']===true,
                    'trading_enabled'=>false,'live_index_prices_verified'=>false]];
            }
            $result=self::supervisorAction($s,$body['service'],$action);
            return [$result['ok']?200:502,[
                'schema'=>self::SCHEMA,'result_code'=>$result['code'],
                'service'=>$body['service'],'status'=>'command_submitted',
                'live_index_prices_verified'=>false,'trading_enabled'=>false
            ]];
        } finally {
            flock($lock,LOCK_UN);fclose($lock);
        }
    }
}

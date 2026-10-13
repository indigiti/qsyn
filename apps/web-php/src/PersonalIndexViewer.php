<?php
declare(strict_types=1);
namespace QSYN\MarketData;

/**
 * Optional personal, non-public index chart access without administrator login.
 * Both Cloudways edge and application must restrict requests to the owner's
 * fixed IP. No user-supplied forwarding headers or arbitrary provider symbols.
 */
final class PersonalIndexViewer
{
    public static function allowed(array $server): bool
    {
        if (getenv('QSYN_PERSONAL_INDEX_OWNER_VIEWER') !== '1'
            || getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') return false;
        $ownerIp=getenv('QSYN_PERSONAL_INDEX_OWNER_IP');
        $ip=$server['REMOTE_ADDR']??null;
        $host=$server['HTTP_HOST']??null;
        $originHost=getenv('QSYN_PERSONAL_INDEX_OWNER_HOST');
        if (!is_string($ownerIp)||!filter_var($ownerIp,FILTER_VALIDATE_IP)
            ||!is_string($ip)||!hash_equals($ownerIp,$ip)
            ||!is_string($host)||!is_string($originHost)
            ||!hash_equals($originHost,$host))return false;
        // HTTPS is mandatory outside the test-only loopback environment.
        return ($server['HTTPS']??'')==='on'
            ||($server['HTTP_X_FORWARDED_PROTO']??'')==='https'
            ||(getenv('QSYN_ALLOW_HTTP_TEST')==='1'
                && preg_match('/^(?:localhost|127\\.0\\.0\\.1)(?::[0-9]+)?$/',$host)===1);
    }

    public static function status(array $server):array
    {
        if (($server['REQUEST_METHOD']??'GET')!=='GET')return [405,['error'=>'method_not_allowed']];
        if (!self::allowed($server))return [403,['error'=>'owner_viewer_unavailable','trading_enabled'=>false]];
        return [200,[
            'schema'=>'QSYN-PERSONAL-INDEX-OWNER-VIEWER/1',
            'access'=>'owner-ip-allowlist','symbols'=>['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','INDIAVIX','SENSEX','BANKEX'],
            'suggested_day_ist'=>(new \DateTimeImmutable('yesterday',new \DateTimeZone('Asia/Kolkata')))->format('Y-m-d'),
            'trading_enabled'=>false,'public_redistribution_allowed'=>false,
        ]];
    }
}

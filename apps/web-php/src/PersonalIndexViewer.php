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
    /**
     * Redacted owner-viewer preflight. Intended only for the authenticated
     * administrator diagnostics endpoint; never expose its individual checks
     * from a denied public /owner-index/status request.
     *
     * REMOTE_ADDR is deliberately authoritative: trusting an unchecked
     * X-Forwarded-For header would let an outsider spoof the owner's IP.
     */
    public static function accessReport(array $server): array
    {
        $ip=$server['REMOTE_ADDR']??null;
        $ownerIp=getenv('QSYN_PERSONAL_INDEX_OWNER_IP');
        $host=$server['HTTP_HOST']??null;
        $ownerHost=getenv('QSYN_PERSONAL_INDEX_OWNER_HOST');
        $checks=[
            'viewer_enabled'=>getenv('QSYN_PERSONAL_INDEX_OWNER_VIEWER')==='1',
            'history_gateway_enabled'=>getenv('QSYN_PERSONAL_INDEX_ENABLED')!=='0',
            'trading_disabled'=>getenv('QSYN_TRADING_ENABLED')!=='1'
                && getenv('QSYN_ENABLE_LIVE_TRADING')!=='1',
            'owner_ip_configured'=>is_string($ownerIp)
                && filter_var($ownerIp,FILTER_VALIDATE_IP)!==false,
            'request_ip_matches'=>is_string($ip)&&is_string($ownerIp)
                && filter_var($ownerIp,FILTER_VALIDATE_IP)!==false
                && hash_equals($ownerIp,$ip),
            'owner_host_configured'=>is_string($ownerHost)&&$ownerHost!=='',
            'request_host_matches'=>is_string($host)&&is_string($ownerHost)
                && $ownerHost!==''&&hash_equals($ownerHost,$host),
            'secure_transport'=>($server['HTTPS']??'')==='on'
                ||($server['HTTP_X_FORWARDED_PROTO']??'')==='https'
                ||(getenv('QSYN_ALLOW_HTTP_TEST')==='1'
                    && is_string($host)
                    && preg_match('/^(?:localhost|127\\.0\\.0\\.1)(?::[0-9]+)?$/',$host)===1),
        ];
        $reasons=[
            'viewer_enabled'=>'OWNER_VIEWER_DISABLED',
            'history_gateway_enabled'=>'OWNER_INDEX_GATEWAY_DISABLED',
            'trading_disabled'=>'OWNER_VIEWER_TRADING_MODE_BLOCKED',
            'owner_ip_configured'=>'OWNER_IP_NOT_CONFIGURED',
            'request_ip_matches'=>'OWNER_REQUEST_IP_NOT_MATCHED',
            'owner_host_configured'=>'OWNER_HOST_NOT_CONFIGURED',
            'request_host_matches'=>'OWNER_REQUEST_HOST_NOT_MATCHED',
            'secure_transport'=>'OWNER_HTTPS_REQUIRED',
        ];
        $first='OWNER_VIEWER_ACCESS_READY';
        foreach ($checks as $key=>$passed) {
            if (!$passed) {$first=$reasons[$key];break;}
        }
        return [
            'access_allowed'=>$first==='OWNER_VIEWER_ACCESS_READY',
            'code'=>$first,
            'checks'=>$checks,
            'source_prices_verified'=>false,
            'edge_allowlist_verified'=>false,
            'trading_enabled'=>false,
        ];
    }

    public static function allowed(array $server): bool
    {
        return self::accessReport($server)['access_allowed'];
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

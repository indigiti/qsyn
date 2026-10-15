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
    private const BROWSER_COOKIE = 'QSYN_OWNER_INDEX';
    private const BROWSER_GRANT_SECONDS = 604800; // Seven days, owner browser only.

    private static function browserGrantMode(): bool
    {
        return getenv('QSYN_PERSONAL_INDEX_OWNER_AUTH') === 'browser_grant';
    }

    /** Independent 0600 signing key outside public_html; never reuse Upstox tokens. */
    private static function signingKey(): ?string
    {
        $root = getenv('QSYN_RUNTIME_DIR');
        if (!is_string($root) || !str_starts_with($root, '/')
            || $root === '/' || str_contains($root, '/..') || str_contains($root, '//')
            || is_link($root) || realpath($root) !== $root
            || preg_match('~/(?:public_html|webroot|www)(?:/|$)~i', $root)) return null;
        $file = $root.'/owner-index-grant.key';
        clearstatcache(true, $file);
        $stat = @lstat($file);
        if ($stat === false || !is_file($file) || is_link($file)
            || ($stat['mode'] & 0077) !== 0 || $stat['size'] !== 32
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid()))
            return null;
        $key = @file_get_contents($file);
        return is_string($key) && strlen($key) === 32 ? $key : null;
    }

    private static function secureTransport(array $server): bool
    {
        $host = (string)($server['HTTP_HOST'] ?? '');
        return ($server['HTTPS'] ?? '') === 'on'
            || ($server['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
            || (getenv('QSYN_ALLOW_HTTP_TEST') === '1'
                && preg_match('/^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/D', $host) === 1);
    }

    private static function sharedChecks(): array
    {
        return [
            'viewer_enabled'=>getenv('QSYN_PERSONAL_INDEX_OWNER_VIEWER') === '1',
            'history_gateway_enabled'=>getenv('QSYN_PERSONAL_INDEX_ENABLED') !== '0',
            'trading_disabled'=>getenv('QSYN_TRADING_ENABLED') !== '1'
                && getenv('QSYN_ENABLE_LIVE_TRADING') !== '1',
        ];
    }

    private static function grantValid(?string $key): bool
    {
        if ($key === null) return false;
        $value = $_COOKIE[self::BROWSER_COOKIE] ?? null;
        if (!is_string($value) || strlen($value) > 128
            || preg_match('/\A([0-9]{10,11})\.([a-f0-9]{32})\.([a-f0-9]{64})\z/D', $value, $m) !== 1)
            return false;
        $expiry = (int)$m[1];
        if ($expiry <= time() || $expiry > time() + self::BROWSER_GRANT_SECONDS)
            return false;
        $signed = $m[1].'.'.$m[2];
        return hash_equals(hash_hmac('sha256', 'QSYN-OWNER-INDEX-V1:'.$signed, $key), $m[3]);
    }

    /**
     * A one-time administrator + CSRF action provisions an HttpOnly browser
     * cookie. Later chart reads have NO admin session / static IP dependency.
     * The host-only Secure SameSite cookie is not returned in the JSON.
     */
    public static function browserGrant(array $server): array
    {
        $method = $server['REQUEST_METHOD'] ?? 'GET';
        if (!in_array($method, ['GET','POST'], true))
            return [405, ['error'=>'method_not_allowed']];
        if (!\QSYN\Admin\RustAdmin::originAllowed($server))
            return [403, ['error'=>'secure_same_origin_required']];
        \QSYN\Admin\RustAdmin::boot();
        if (!\QSYN\Admin\RustAdmin::authenticated())
            return [401, ['error'=>'admin_login_required']];
        if (!self::browserGrantMode() || !self::sharedChecks()['viewer_enabled']
            || !self::sharedChecks()['history_gateway_enabled']
            || !self::sharedChecks()['trading_disabled'])
            return [503, ['error'=>'owner_browser_grant_disabled']];
        $key = self::signingKey();
        if ($method === 'GET') return [200, [
            'schema'=>'QSYN-OWNER-BROWSER-GRANT/1',
            'grant_ready'=>$key !== null,
            'csrf'=>\QSYN\Admin\RustAdmin::csrf(),
            'trading_enabled'=>false,
        ]];
        if (!\QSYN\Admin\RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN'] ?? '')))
            return [403, ['error'=>'csrf_invalid']];
        if ($key === null) return [503, ['error'=>'owner_browser_grant_key_unavailable']];
        $expiry=time()+self::BROWSER_GRANT_SECONDS;
        $value=$expiry.'.'.bin2hex(random_bytes(16));
        $value.='.'.hash_hmac('sha256', 'QSYN-OWNER-INDEX-V1:'.$value, $key);
        $localTest=getenv('QSYN_ALLOW_HTTP_TEST') === '1'
            && preg_match('/^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/D',
                (string)($server['HTTP_HOST'] ?? '')) === 1;
        if (!setcookie(self::BROWSER_COOKIE,$value,[
            'expires'=>$expiry, 'path'=>'/qsyn/', 'secure'=>!$localTest,
            'httponly'=>true, 'samesite'=>'Strict',
        ])) return [503, ['error'=>'owner_browser_cookie_unavailable']];
        return [200, [
            'schema'=>'QSYN-OWNER-BROWSER-GRANT/1',
            'browser_authorized'=>true, 'expires_at_utc'=>gmdate('c',$expiry),
            'trading_enabled'=>false, 'public_redistribution_allowed'=>false,
        ]];
    }

    public static function accessReport(array $server): array
    {
        $checks=self::sharedChecks();
        $reasons=[
            'viewer_enabled'=>'OWNER_VIEWER_DISABLED',
            'history_gateway_enabled'=>'OWNER_INDEX_GATEWAY_DISABLED',
            'trading_disabled'=>'OWNER_VIEWER_TRADING_MODE_BLOCKED',
        ];
        if (self::browserGrantMode()) {
            $key=self::signingKey();
            $checks['browser_grant_key_ready']=$key !== null;
            $checks['browser_grant_valid']=self::grantValid($key);
            $checks['secure_transport']=self::secureTransport($server);
            $reasons+= [
                'browser_grant_key_ready'=>'OWNER_BROWSER_GRANT_KEY_MISSING',
                'browser_grant_valid'=>'OWNER_BROWSER_GRANT_MISSING_OR_EXPIRED',
                'secure_transport'=>'OWNER_HTTPS_REQUIRED',
            ];
        } else {
            // Backward-compatible legacy fixed-IP mode; never trust arbitrary
            // forwarding headers or allow a public fallback.
            $ip=$server['REMOTE_ADDR']??null;
            $ownerIp=getenv('QSYN_PERSONAL_INDEX_OWNER_IP');
            $host=$server['HTTP_HOST']??null;
            $ownerHost=getenv('QSYN_PERSONAL_INDEX_OWNER_HOST');
            $checks+= [
                'owner_ip_configured'=>is_string($ownerIp)
                    && filter_var($ownerIp,FILTER_VALIDATE_IP)!==false,
                'request_ip_matches'=>is_string($ip)&&is_string($ownerIp)
                    && filter_var($ownerIp,FILTER_VALIDATE_IP)!==false
                    && hash_equals($ownerIp,$ip),
                'owner_host_configured'=>is_string($ownerHost)&&$ownerHost!=='',
                'request_host_matches'=>is_string($host)&&is_string($ownerHost)
                    && $ownerHost!==''&&hash_equals($ownerHost,$host),
                'secure_transport'=>self::secureTransport($server),
            ];
            $reasons+= [
                'owner_ip_configured'=>'OWNER_IP_NOT_CONFIGURED',
                'request_ip_matches'=>'OWNER_REQUEST_IP_NOT_MATCHED',
                'owner_host_configured'=>'OWNER_HOST_NOT_CONFIGURED',
                'request_host_matches'=>'OWNER_REQUEST_HOST_NOT_MATCHED',
                'secure_transport'=>'OWNER_HTTPS_REQUIRED',
            ];
        }
        $first='OWNER_VIEWER_ACCESS_READY';
        foreach ($checks as $name=>$passed) {
            if (!$passed) {$first=$reasons[$name];break;}
        }
        return [
            'access_allowed'=>$first==='OWNER_VIEWER_ACCESS_READY',
            'code'=>$first,'checks'=>$checks,
            'source_prices_verified'=>false,'edge_allowlist_verified'=>false,
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
            'access'=>self::browserGrantMode()?'owner-browser-grant':'owner-ip-allowlist','symbols'=>['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','INDIAVIX','SENSEX','BANKEX'],
            'suggested_day_ist'=>(new \DateTimeImmutable('yesterday',new \DateTimeZone('Asia/Kolkata')))->format('Y-m-d'),
            'trading_enabled'=>false,'public_redistribution_allowed'=>false,
        ]];
    }
}

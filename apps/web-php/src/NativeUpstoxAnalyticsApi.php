<?php
declare(strict_types=1);

namespace QSYN\Broker;

use QSYN\Admin\RustAdmin;

/**
 * Independent read-only Analytics Token intake. No OAuth client secret, no
 * account-identifying GET unless the host has independently configured it.
 * Provider feed authorization is NOT proof of a display/retention license.
 */
final class NativeUpstoxAnalyticsApi
{
    private const SCHEMA = 'QSYN-UPSTOX-ANALYTICS-SESSION/1';
    private const STATUS = 'QSYN-UPSTOX-ANALYTICS-STATUS/1';
    private const AUTH_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
    private const FILE = 'upstox-analytics-session.json';

    private static function deny(): \RuntimeException
    {
        return new \RuntimeException('analytics_private_configuration_unavailable');
    }

    private static function directory(bool $create): string
    {
        $runtime = getenv('QSYN_RUNTIME_DIR');
        if (!is_string($runtime) || $runtime === '' || $runtime[0] !== '/'
            || str_contains($runtime, '/..') || is_link($runtime)
            || realpath($runtime) !== $runtime
            || preg_match('~/(?:public_html|webroot|www)(?:/|$)~i', $runtime)
            || !is_dir($runtime) || ((int)@fileperms($runtime) & 0002) !== 0) {
            throw self::deny();
        }
        $root = $runtime . '/upstox-private';
        if (!is_dir($root) && $create) {
            $mask = umask(0077);
            try { if (!@mkdir($root, 0700)) throw self::deny(); }
            finally { umask($mask); }
        }
        $stat = @lstat($root);
        if ($stat === false || realpath($root) !== $root
            || !is_dir($root) || is_link($root)
            || ($stat['mode'] & 0077) !== 0
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())) {
            throw self::deny();
        }
        return $root;
    }

    private static function privateFile(string $path, int $limit): bool
    {
        clearstatcache(true, $path);
        $stat = @lstat($path);
        return $stat !== false && is_file($path) && !is_link($path)
            && ($stat['mode'] & 0077) === 0
            && $stat['size'] > 0 && $stat['size'] <= $limit
            && (function_exists('posix_geteuid') === false || $stat['uid'] === posix_geteuid());
    }

    private static function expectedUser(string $root): string
    {
        // A server-operator account binding is mandatory. Never obtain this ID
        // from the token submitted by the browser.
        $expected = getenv('QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID');
        if (!is_string($expected) || $expected === '') {
            $app = $root . '/upstox-app.json';
            if (self::privateFile($app, 2048)) {
                $data = json_decode((string)file_get_contents($app), true);
                if (is_array($data) && ($data['schema'] ?? null) === 'QSYN-UPSTOX-WEB-APP/1') {
                    $expected = $data['expected_user_id'] ?? null;
                }
            }
        }
        if (!is_string($expected)
            || preg_match('/\A[A-Za-z0-9_.@-]{2,128}\z/D', $expected) !== 1) {
            throw self::deny();
        }
        return $expected;
    }

    /** Authenticate only the *market feed authorize* GET endpoint, not User
     * Profile: Analytics Token profile reads can require static-IP whitelisting.
     * A returned one-use WSS URL is validated locally and immediately dropped.
     */
    public static function marketAuthorize(string $token): bool
    {
        if (!function_exists('curl_init')) return false;
        $ch = curl_init(self::AUTH_URL);
        if ($ch === false) return false;
        try {
            curl_setopt_array($ch, [
                CURLOPT_HTTPGET=>true, CURLOPT_RETURNTRANSFER=>true,
                CURLOPT_CONNECTTIMEOUT=>5, CURLOPT_TIMEOUT=>12,
                CURLOPT_FOLLOWLOCATION=>false, CURLOPT_SSL_VERIFYHOST=>2,
                CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_MAXREDIRS=>0,
                CURLOPT_HTTPHEADER=>[
                    'Authorization: Bearer ' . $token,
                    'Accept: application/json',
                ],
            ]);
            $raw = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($code !== 200 || !is_string($raw) || strlen($raw) > 8192) return false;
            $decoded = json_decode($raw, true, 12);
            return self::validAuthorization($decoded);
        } finally {
            curl_close($ch);
        }
    }

    public static function validAuthorization(mixed $response): bool
    {
        if (!is_array($response) || ($response['status'] ?? null) !== 'success') return false;
        $url = $response['data']['authorized_redirect_uri'] ?? null;
        if (!is_string($url) || strlen($url) > 4096
            || !str_starts_with($url, 'wss://')) return false;
        $parts = parse_url($url);
        if (!is_array($parts) || ($parts['scheme'] ?? null) !== 'wss'
            || !is_string($parts['host'] ?? null)
            || !str_ends_with(strtolower($parts['host']), '.upstox.com')
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])
            || (isset($parts['port']) && $parts['port'] !== 443)) return false;
        return true;
    }

    private static function withLock(string $root, callable $action): mixed
    {
        $path = $root . '/.analytics-token-lock';
        if (is_link($path)) throw self::deny();
        $mask = umask(0077);
        try { $handle = @fopen($path, 'c'); }
        finally { umask($mask); }
        if ($handle === false) throw self::deny();
        try {
            $stat = @lstat($path);
            if (!$stat || ($stat['mode'] & 0077) !== 0
                || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())
                || !flock($handle, LOCK_EX)) throw self::deny();
            return $action();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** Separate 0600 Analytics file: never overwrite the OAuth session.
     * Index worker must be operator-configured to select this exact path.
     */
    public static function store(string $root, string $user, string $token, callable $authorize): bool
    {
        if (strlen($token) < 20 || strlen($token) > 8192
            || preg_match('/\A[\x21-\x7e]+\z/D', $token) !== 1
            || str_contains($token, '\\') || str_contains($token, '"')) return false;
        if ($authorize($token) !== true) return false;
        self::withLock($root, static function() use ($root, $user, $token): void {
            $path = $root . '/' . self::FILE;
            if (file_exists($path) || is_link($path)) {
                if (!self::privateFile($path, 16384)) throw self::deny();
            }
            $data = json_encode([
                'schema'=>self::SCHEMA,
                'broker'=>'upstox','user_id'=>$user,'access_token'=>$token,
                'created_at'=>gmdate('c'),
                'order_routing_enabled'=>false,
                'display_entitlement_verified'=>false,
                'retention_entitlement_verified'=>false,
            ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            $temp = tempnam($root, '.analytics-');
            if ($temp === false) throw self::deny();
            try {
                if (!chmod($temp, 0600)
                    || file_put_contents($temp, $data, LOCK_EX) !== strlen($data)
                    || !rename($temp, $path)) throw self::deny();
            } finally {
                if (is_file($temp)) @unlink($temp);
            }
        });
        return true;
    }

    /**
     * Verify the existing private Analytics Token without receiving a secret
     * from the browser. Never return the token or the one-use WSS redirect.
     */
    public static function verifyStored(string $root, string $expectedUser, callable $authorize): ?bool
    {
        $path = $root . '/' . self::FILE;
        if (!self::privateFile($path, 16384)) return null;
        try {
            $record = json_decode((string)file_get_contents($path), true, 10, JSON_THROW_ON_ERROR);
        } catch (\\Throwable) {
            return null;
        }
        if (!is_array($record) || array_is_list($record)
            || count($record) !== 8
            || ($record['schema'] ?? null) !== self::SCHEMA
            || ($record['broker'] ?? null) !== 'upstox'
            || ($record['user_id'] ?? null) !== $expectedUser
            || !is_string($record['created_at'] ?? null)
            || ($record['order_routing_enabled'] ?? null) !== false
            || ($record['display_entitlement_verified'] ?? null) !== false
            || ($record['retention_entitlement_verified'] ?? null) !== false
            || !is_string($record['access_token'] ?? null)) return null;
        $token = $record['access_token'];
        if (strlen($token) < 20 || strlen($token) > 8192
            || preg_match('/\\A[\\x21-\\x7e]+\\z/D', $token) !== 1
            || str_contains($token, '\\\\') || str_contains($token, '"')) return null;
        try {
            return $authorize($token) === true;
        } catch (\\Throwable) {
            return false;
        }
    }

    private static function clear(string $root): void
    {
        self::withLock($root, static function() use ($root): void {
            $path = $root . '/' . self::FILE;
            if (file_exists($path) || is_link($path)) {
                if (!self::privateFile($path, 16384) || !unlink($path)) throw self::deny();
            }
        });
    }

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(string $action, array $server, ?callable $authorize = null): array
    {
        if (!in_array($action, ['status', 'import', 'clear', 'verify'], true)) {
            return [404, ['error'=>'not_found']];
        }
        $method = $action === 'status' ? 'GET' : 'POST';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $method) {
            return [405, ['error'=>'method_not_allowed']];
        }
        if (getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1'
            || getenv('QSYN_UPSTOX_ANALYTICS_IMPORT_ENABLED') !== '1') {
            return [503, ['error'=>'analytics_token_import_disabled']];
        }
        if (!RustAdmin::originAllowed($server)) {
            return [403, ['error'=>'secure_same_origin_required']];
        }
        RustAdmin::boot();
        if (!RustAdmin::authenticated()) {
            return [401, ['error'=>'admin_login_required']];
        }
        try {
            $root = self::directory($action === 'import');
            $user = self::expectedUser($root);
        } catch (\Throwable) {
            return [503, ['error'=>'analytics_account_binding_unavailable']];
        }
        if ($action === 'status') {
            $stored = self::privateFile($root . '/' . self::FILE, 16384);
            return [200, [
                'schema'=>self::STATUS, 'token_stored'=>$stored,
                'provider_feed_authorized_now'=>false,
                'provider_account_identity_verified'=>false,
                'index_feed_activated'=>false,'trading_enabled'=>false,
                'token_type'=>'analytics_read_only',
                'csrf'=>RustAdmin::csrf(),
            ]];
        }
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error'=>'csrf_invalid']];
        }
        if (preg_match('~^application/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE'] ?? '')) !== 1) {
            return [415, ['error'=>'json_required']];
        }
        $raw = file_get_contents('php://input', false, null, 0, 8500);
        if (!is_string($raw) || strlen($raw) > 8499) {
            return [413, ['error'=>'request_too_large']];
        }
        try { $body = json_decode($raw, true, 4, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { return [400, ['error'=>'invalid_json']]; }
        if (!is_array($body) || array_is_list($body)
            || ($body['confirmed'] ?? false) !== true
            || count($body) !== ($action === 'import' ? 2 : 1)) {
            return [422, ['error'=>'invalid_analytics_request']];
        }
        if ($action === 'verify') {
            $ok = self::verifyStored($root, $user,
                $authorize ?? [self::class, 'marketAuthorize']);
            if ($ok === null) {
                return [409, ['error'=>'analytics_private_token_not_ready']];
            }
            return [200, [
                'schema'=>self::STATUS,
                'token_stored'=>true,
                'provider_feed_authorized_now'=>$ok,
                'diagnostic_code'=>$ok
                    ? 'UPSTOX_ANALYTICS_MARKET_AUTHORIZED_NOW'
                    : 'UPSTOX_ANALYTICS_MARKET_AUTH_UNAVAILABLE',
                'provider_account_identity_verified'=>false,
                'index_feed_activated'=>false,
                'trading_enabled'=>false,
                'checked_at_utc'=>gmdate('c'),
            ]];
        }
        if ($action === 'clear') {
            try { self::clear($root); }
            catch (\Throwable) { return [503, ['error'=>'analytics_local_clear_failed']]; }
            return [200, ['schema'=>self::STATUS, 'token_stored'=>false,
                'provider_token_revoked'=>false, 'trading_enabled'=>false]];
        }
        if (!is_string($body['token'] ?? null)) {
            return [422, ['error'=>'invalid_analytics_request']];
        }
        try {
            $ok = self::store($root, $user, $body['token'],
                $authorize ?? [self::class, 'marketAuthorize']);
        } catch (\Throwable) {
            return [503, ['error'=>'analytics_private_storage_unavailable']];
        }
        if (!$ok) {
            return [422, ['error'=>'analytics_market_authorization_failed']];
        }
        return [200, [
            'schema'=>self::STATUS, 'token_stored'=>true,
            'market_feed_authorized_at_import'=>true,
            'provider_account_identity_verified'=>false,
            'index_feed_activated'=>false, 'trading_enabled'=>false,
        ]];
    }
}

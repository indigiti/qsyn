<?php
declare(strict_types=1);

namespace QSYN\Broker;

use QSYN\Admin\RustAdmin;

/**
 * Native Upstox OAuth web control for the single QSYN operator account.
 * OAuth and private token are NOT market-data display approval or OMS.
 */
final class NativeUpstoxWebApi
{
    private const SCHEMA = 'QSYN-NATIVE-UPSTOX-WEB/1';
    private const CALLBACK = '/qsyn/api/v1/admin/upstox/callback';
    private const CONFIG = 'upstox-app.json';
    private const SECRET = 'upstox-client-secret.key';

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(
        string $operation, array $server, array $query = [], ?callable $exchange = null
    ): array {
        if (getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1'
            || getenv('QSYN_CONTROL_ENABLED') === '0') {
            return [503, ['error' => 'native_upstox_disabled']];
        }
        if ($operation === 'callback') {
            // External Upstox GET has no QSYN Strict SameSite cookie.
            // A 256-bit, 5-minute, one-use state authorizes this callback.
            return self::callback($server, $query, $exchange);
        }
        if (!RustAdmin::originAllowed($server)) {
            return [403, ['error' => 'secure_same_origin_required']];
        }
        RustAdmin::boot();
        $method = $operation === 'status' ? 'GET' : 'POST';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $method) {
            return [405, ['error' => 'method_not_allowed']];
        }
        if (!RustAdmin::authenticated()) {
            return [401, ['error' => 'admin_login_required']];
        }
        if ($operation === 'status') {
            try {
                $root = self::privateDir(false);
                $config = $root !== null ? self::config($root) : null;
                $status = $config !== null ? (new UpstoxOperatorOAuth($root))->status() : null;
                return [200, [
                    'schema' => self::SCHEMA,
                    'configured' => $config !== null,
                    'token_stored' => ($status['token_stored'] ?? false) === true,
                    'provider_user_id_checked_at_exchange' => ($status['account_verified'] ?? false) === true,
                    'oauth_callback_uri' => self::redirectUri($server),
                    'index_feed_activated' => false,
                    'index_display_entitlement_verified' => false,
                    'upstox_session_currently_verified' => false,
                    'trading_enabled' => false,
                    'csrf' => RustAdmin::csrf(),
                ]];
            } catch (\Throwable) {
                return [503, ['error' => 'private_upstox_configuration_unavailable']];
            }
        }
        if (!in_array($operation, ['setup', 'begin'], true)) {
            return [404, ['error' => 'not_found']];
        }
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error' => 'csrf_invalid']];
        }
        if (preg_match('~^application/json(?:\s*;|$)~i',
                (string)($server['CONTENT_TYPE'] ?? '')) !== 1) {
            return [415, ['error' => 'json_required']];
        }
        $raw = file_get_contents('php://input', false, null, 0, 4097);
        if (!is_string($raw) || strlen($raw) > 4096) {
            return [413, ['error' => 'request_too_large']];
        }
        try {
            $body = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!is_array($body) || array_is_list($body)) {
            return [422, ['error' => 'invalid_upstox_request']];
        }

        if ($operation === 'setup') {
            if (array_keys($body) !== ['client_id', 'client_secret', 'expected_user_id', 'confirmed']
                || $body['confirmed'] !== true
                || !is_string($body['client_id'])
                || !preg_match('/^[A-Za-z0-9_-]{8,128}$/D', $body['client_id'])
                || !is_string($body['expected_user_id'])
                || !preg_match('/^[A-Za-z0-9_.@-]{2,128}$/D', $body['expected_user_id'])
                || !is_string($body['client_secret'])
                || strlen($body['client_secret']) < 8
                || strlen($body['client_secret']) > 512
                || preg_match('/^[\x21-\x7E]+$/D', $body['client_secret']) !== 1) {
                return [422, ['error' => 'invalid_upstox_app_configuration']];
            }
            try {
                self::saveConfig($body, self::redirectUri($server));
                return [201, [
                    'schema' => self::SCHEMA, 'configured' => true,
                    'oauth_callback_uri' => self::redirectUri($server),
                    'token_stored' => false, 'index_feed_activated' => false,
                    'trading_enabled' => false,
                ]];
            } catch (\Throwable) {
                return [409, ['error' => 'upstox_setup_unavailable_or_exists']];
            }
        }
        if ($body !== []) {
            return [422, ['error' => 'invalid_upstox_request']];
        }
        try {
            $root = self::privateDir(false);
            if ($root === null) throw new \RuntimeException('not_configured');
            $config = self::config($root);
            if ($config === null || $config['redirect_uri'] !== self::redirectUri($server)) {
                throw new \RuntimeException('callback_mismatch');
            }
            $url = (new UpstoxOperatorOAuth($root))->begin(
                $config['client_id'], $config['redirect_uri'], $config['expected_user_id']
            );
            return [200, [
                'schema' => self::SCHEMA, 'authorization_url' => $url,
                'oauth_pending' => true, 'trading_enabled' => false,
            ]];
        } catch (\Throwable) {
            return [503, ['error' => 'upstox_authorization_not_ready']];
        }
    }

    private static function callback(array $server, array $query, ?callable $exchange): array
    {
        if (($server['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            return [405, ['error' => 'method_not_allowed']];
        }
        try {
            $redirect = self::redirectUri($server);
            if (!isset($query['state'], $query['code'])
                || count($query) !== 2
                || !is_string($query['state']) || !is_string($query['code'])) {
                return [400, ['error' => 'invalid_upstox_callback']];
            }
            $root = self::privateDir(false);
            if ($root === null) throw new \RuntimeException('not_configured');
            $config = self::config($root);
            if ($config === null || $config['redirect_uri'] !== $redirect) {
                throw new \RuntimeException('redirect_mismatch');
            }
            $secret = trim(self::readPrivate($root . '/' . self::SECRET, 1024));
            $oauth = new UpstoxOperatorOAuth($root);
            $result = $oauth->finish(
                $query['state'], $query['code'], $secret,
                $exchange ?? [UpstoxOperatorOAuth::class, 'exchangeWithCurl']
            );
            if (($result['account_verified'] ?? false) !== true) {
                throw new \RuntimeException('not_verified');
            }
            return [303, ['location' => '/qsyn/terminal/brokers?upstox_oauth=stored']];
        } catch (\Throwable) {
            // OAuth failure is deliberately opaque, no code/state/token reflected.
            return [303, ['location' => '/qsyn/terminal/brokers?upstox_oauth=failed']];
        }
    }

    private static function redirectUri(array $server): string
    {
        $host = (string)($server['HTTP_HOST'] ?? '');
        $local = getenv('QSYN_ALLOW_HTTP_TEST') === '1'
            && preg_match('/^127\.0\.0\.1:[0-9]{2,5}$/D', $host) === 1;
        $trusted = $host === 'stage.digiti.in'
            && (($server['HTTPS'] ?? '') === 'on'
                || ($server['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        if (!$trusted && !$local) {
            throw new \RuntimeException('untrusted_oauth_host');
        }
        // The registered upstream URL must be EXACTLY this callback.
        // Loopback is used solely for automated local HTTP tests.
        return ($local ? 'http://' : 'https://') . $host . self::CALLBACK;
    }

    private static function privateDir(bool $create): ?string
    {
        $parent = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2) . '/runtime');
        if (!str_starts_with($parent, '/') || is_link($parent)
            || realpath($parent) !== $parent || !is_dir($parent)
            || ((int)@fileperms($parent) & 0002) !== 0
            || preg_match('~/(?:public_html|webroot|www)/~i', $parent)) {
            throw new \RuntimeException('private_runtime_required');
        }
        $override = getenv('QSYN_UPSTOX_PRIVATE_DIR');
        $root = is_string($override) && $override !== '' ? $override : $parent . '/upstox-private';
        if (!str_starts_with($root, '/') || str_contains($root, '/../')
            || ($override && !str_starts_with($root, $parent . '/'))) {
            throw new \RuntimeException('private_upstox_root_invalid');
        }
        if (!is_dir($root)) {
            if (!$create) return null;
            $old = umask(0077);
            try {
                if (!@mkdir($root, 0700)) throw new \RuntimeException('private_upstox_mkdir_failed');
            } finally { umask($old); }
        }
        $st = @lstat($root);
        if ($st === false || realpath($root) !== $root || !is_dir($root)
            || is_link($root) || ($st['mode'] & 0077) !== 0
            || (function_exists('posix_geteuid') && $st['uid'] !== posix_geteuid())) {
            throw new \RuntimeException('private_upstox_root_unavailable');
        }
        return $root;
    }

    private static function readPrivate(string $path, int $max): string
    {
        $st = @lstat($path);
        if ($st === false || !is_file($path) || is_link($path)
            || ($st['mode'] & 0077) !== 0 || $st['size'] < 1 || $st['size'] > $max
            || (function_exists('posix_geteuid') && $st['uid'] !== posix_geteuid())) {
            throw new \RuntimeException('private_upstox_config_missing');
        }
        $raw = @file_get_contents($path);
        if (!is_string($raw)) throw new \RuntimeException('private_read_failed');
        return $raw;
    }

    private static function config(string $root): ?array
    {
        if (!file_exists($root . '/' . self::CONFIG)) return null;
        $json = json_decode(self::readPrivate($root . '/' . self::CONFIG, 2048),
            true, 12, JSON_THROW_ON_ERROR);
        if (!is_array($json) || ($json['schema'] ?? null) !== 'QSYN-UPSTOX-WEB-APP/1'
            || !isset($json['client_id'], $json['expected_user_id'], $json['redirect_uri'])) {
            throw new \RuntimeException('upstox_config_invalid');
        }
        return $json;
    }

    private static function writeNew(string $path, string $data): void
    {
        $mask = umask(0077);
        try { $f = @fopen($path, 'x'); } finally { umask($mask); }
        if ($f === false) throw new \RuntimeException('upstox_private_exists');
        try {
            if (!@chmod($path, 0600)
                || fwrite($f, $data) !== strlen($data)
                || !fflush($f)) {
                throw new \RuntimeException('upstox_private_write_failed');
            }
        } catch (\Throwable $e) {
            fclose($f); @unlink($path); throw $e;
        }
        fclose($f);
    }

    private static function saveConfig(array $form, string $redirect): void
    {
        $root = self::privateDir(true);
        $lockPath = $root . '/.upstox-setup-lock';
        if (is_link($lockPath)) throw new \RuntimeException('unsafe_lock');
        $mask = umask(0077);
        try { $lock = @fopen($lockPath, 'c'); } finally { umask($mask); }
        if ($lock === false) throw new \RuntimeException('lock_unavailable');
        try {
            $st = @lstat($lockPath);
            if (!$st || ($st['mode'] & 0077) !== 0
                || (function_exists('posix_geteuid') && $st['uid'] !== posix_geteuid())
                || !flock($lock, LOCK_EX)) {
                throw new \RuntimeException('unsafe_lock');
            }
            $secretPath = $root . '/' . self::SECRET;
            $configPath = $root . '/' . self::CONFIG;
            if (file_exists($secretPath) || is_link($secretPath)
                || file_exists($configPath) || is_link($configPath)) {
                throw new \RuntimeException('setup_already_exists');
            }
            self::writeNew($secretPath, $form['client_secret'] . "\n");
            try {
                self::writeNew($configPath, json_encode([
                    'schema' => 'QSYN-UPSTOX-WEB-APP/1',
                    'client_id' => $form['client_id'],
                    'expected_user_id' => $form['expected_user_id'],
                    'redirect_uri' => $redirect,
                ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n");
            } catch (\Throwable $e) {
                @unlink($secretPath);
                throw $e;
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

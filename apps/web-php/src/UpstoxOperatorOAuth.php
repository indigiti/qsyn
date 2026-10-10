<?php
declare(strict_types=1);

namespace QSYN\Broker;

use RuntimeException;

/**
 * Operator-controlled Upstox authorization-code OAuth.
 *
 * No public callback route, simulated login bypass, refresh assumption,
 * browser token, implicit live-order enablement, or database dependency.
 * An operator must complete upstream consent and supply code+state via stdin.
 */
final class UpstoxOperatorOAuth
{
    private const AUTH_URI = 'https://api.upstox.com/v2/login/authorization/dialog';
    private const TOKEN_URI = 'https://api.upstox.com/v2/login/authorization/token';
    private const PENDING = 'upstox-oauth-pending.json';
    private const SESSION = 'upstox-session.json';

    public function __construct(private string $privateRoot)
    {
        $real = realpath($privateRoot);
        $stat = @lstat($privateRoot);
        if ($real === false || $real !== $privateRoot || $real === '/'
            || !is_dir($real) || is_link($privateRoot) || $stat === false
            || ($stat['mode'] & 0077) !== 0
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())) {
            throw new RuntimeException('private_oauth_root_not_approved');
        }
    }

    private function path(string $base): string
    {
        return $this->privateRoot . DIRECTORY_SEPARATOR . $base;
    }

    private function privateRead(string $base, int $max): array
    {
        $path = $this->path($base);
        $stat = @lstat($path);
        if (!$stat || !is_file($path) || is_link($path) || ($stat['mode'] & 0077) !== 0
            || $stat['size'] < 1 || $stat['size'] > $max
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())) {
            throw new RuntimeException('private_oauth_file_unavailable');
        }
        return json_decode((string) file_get_contents($path), true, 16, JSON_THROW_ON_ERROR);
    }

    private function atomicWrite(string $base, array $data): void
    {
        $path = $this->path($base);
        if (file_exists($path) || is_link($path)) {
            $stat = @lstat($path);
            if (!$stat || is_link($path) || !is_file($path)
                || ($stat['mode'] & 0077) !== 0
                || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())) {
                throw new RuntimeException('unsafe_existing_oauth_file');
            }
        }
        $temp = tempnam($this->privateRoot, '.oauth-');
        if ($temp === false) throw new RuntimeException('oauth_write_failed');
        try {
            if (!chmod($temp, 0600)) throw new RuntimeException('oauth_write_failed');
            $bytes = json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            if (file_put_contents($temp, $bytes, LOCK_EX) !== strlen($bytes)
                || !rename($temp, $path)) {
                throw new RuntimeException('oauth_write_failed');
            }
        } finally {
            if (is_file($temp)) unlink($temp);
        }
    }

    private static function validateConfig(string $clientId, string $redirectUri, string $expectedUserId): void
    {
        if (!preg_match('/^[A-Za-z0-9_-]{8,128}$/D', $clientId)
            || !preg_match('/^[A-Za-z0-9_.@-]{2,128}$/D', $expectedUserId)
            || strlen($redirectUri) > 350
            || !str_starts_with($redirectUri, 'https://')
            || filter_var($redirectUri, FILTER_VALIDATE_URL) === false
            || parse_url($redirectUri, PHP_URL_USER) !== null
            || parse_url($redirectUri, PHP_URL_FRAGMENT) !== null) {
            throw new RuntimeException('upstox_oauth_config_invalid');
        }
    }

    public function begin(string $clientId, string $redirectUri, string $expectedUserId): string
    {
        self::validateConfig($clientId, $redirectUri, $expectedUserId);
        $state = bin2hex(random_bytes(32));
        $this->atomicWrite(self::PENDING, [
            'schema' => 'QSYN-UPSTOX-OAUTH-PENDING/1',
            'state_sha256' => hash('sha256', $state),
            'client_id' => $clientId,
            'redirect_uri' => $redirectUri,
            'expected_user_id' => $expectedUserId,
            'expires_at' => time() + 300,
        ]);
        return self::AUTH_URI . '?' . http_build_query([
            'client_id' => $clientId, 'redirect_uri' => $redirectUri,
            'response_type' => 'code', 'state' => $state,
        ], '', '&', PHP_QUERY_RFC3986);
    }

    /**
     * Consume state BEFORE network exchange: retries require fresh consent.
     *
     * The transport receives the ephemeral code and client secret in-process,
     * and is not allowed to log them or forward them to any other hostname.
     */
    public function finish(
        string $state, string $code, string $clientSecret,
        callable $exchange
    ): array {
        if (!preg_match('/^[a-f0-9]{64}$/D', $state)
            || strlen($code) < 3 || strlen($code) > 512
            || preg_match('/[\x00-\x20\x7f]/', $code)
            || strlen($clientSecret) < 8 || strlen($clientSecret) > 512) {
            throw new RuntimeException('invalid_oauth_callback');
        }
        $pending = $this->privateRead(self::PENDING, 2048);
        $path = $this->path(self::PENDING);
        if (!unlink($path)) throw new RuntimeException('oauth_pending_consume_failed');
        if (($pending['schema'] ?? null) !== 'QSYN-UPSTOX-OAUTH-PENDING/1'
            || ($pending['expires_at'] ?? 0) < time()
            || !hash_equals((string) ($pending['state_sha256'] ?? ''),
                hash('sha256', $state))) {
            throw new RuntimeException('oauth_state_invalid_or_expired');
        }
        $result = $exchange(self::TOKEN_URI, [
            'code' => $code, 'client_id' => $pending['client_id'],
            'client_secret' => $clientSecret,
            'redirect_uri' => $pending['redirect_uri'],
            'grant_type' => 'authorization_code',
        ]);
        if (!is_array($result) || ($result['user_id'] ?? null) !== $pending['expected_user_id']
            || !is_string($result['access_token'] ?? null)
            || !preg_match('/^[A-Za-z0-9._~+\/=\-]{20,8192}$/D', $result['access_token'])
            || (array_key_exists('token_type', $result)
                && (!is_string($result['token_type'])
                    || strcasecmp($result['token_type'], 'Bearer') !== 0))) {
            throw new RuntimeException('oauth_broker_identity_not_verified');
        }
        // No refresh_token assumption: Upstox auth codes are one-use.
        // Reauthorize using a new login when provider invalidates the session.
        $this->atomicWrite(self::SESSION, [
            'schema' => 'QSYN-UPSTOX-AUTH-SESSION/1',
            'broker' => 'upstox', 'user_id' => $result['user_id'],
            'access_token' => $result['access_token'],
            'created_at' => gmdate('c'),
            'order_routing_enabled' => false,
            'display_entitlement_verified' => false,
            'retention_entitlement_verified' => false,
        ]);
        return ['status' => 'stored_private', 'account_verified' => true,
            'trading_enabled' => false, 'market_feed_enabled' => false];
    }

    public static function exchangeWithCurl(string $url, array $form): array
    {
        if ($url !== self::TOKEN_URI || !function_exists('curl_init')) {
            throw new RuntimeException('approved_curl_transport_unavailable');
        }
        $curl = curl_init($url);
        if (!$curl) throw new RuntimeException('oauth_transport_failed');
        try {
            curl_setopt_array($curl, [
                CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($form, '', '&', PHP_QUERY_RFC3986),
                CURLOPT_HTTPHEADER => ['Accept: application/json','Content-Type: application/x-www-form-urlencoded'],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 12,
                CURLOPT_FOLLOWLOCATION => false, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $body = curl_exec($curl);
            $status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
            if (!is_string($body) || $status !== 200 || strlen($body) > 32768) {
                throw new RuntimeException('oauth_token_exchange_failed');
            }
            $json = json_decode($body, true, 24, JSON_THROW_ON_ERROR);
            if (!is_array($json)) throw new RuntimeException('oauth_token_response_invalid');
            return $json;
        } finally {
            curl_close($curl);
        }
    }

    public function status(): array
    {
        try {
            $session = $this->privateRead(self::SESSION, 16384);
            return [
                'broker' => 'upstox',
                'token_stored' => ($session['schema'] ?? '') === 'QSYN-UPSTOX-AUTH-SESSION/1',
                'account_verified' => isset($session['user_id']),
                'feed_connected' => false,
                'live_order_routing_enabled' => false,
            ];
        } catch (\Throwable) {
            return ['broker' => 'upstox', 'token_stored' => false,
                'account_verified' => false, 'feed_connected' => false,
                'live_order_routing_enabled' => false];
        }
    }
}

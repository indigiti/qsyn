<?php
declare(strict_types=1);

namespace QSYN\Broker;

/**
 * On-demand Upstox profile verification. A stored bearer token is insufficient:
 * every check calls the official read-only endpoint and matches the same
 * account ID previously attested at OAuth exchange.
 */
final class NativeUpstoxProfileVerifier
{
    private const PROFILE = 'https://api.upstox.com/v2/user/profile';

    /** No raw provider identity, email, token, or response is returned. */
    public static function verify(
        string $privateRoot, string $expectedUserId, ?callable $transport = null
    ): array {
        $result = [
            'session_verified' => false,
            'status' => 'unavailable_or_expired',
            'diagnostic_code' => 'UPSTOX_TOKEN_MISSING_OR_PRIVATE_FILE_UNAVAILABLE',
            'profile_account_matches' => false,
            'provider_account_active' => false,
            'index_display_entitlement_verified' => false,
            'index_feed_activated' => false,
            'trading_enabled' => false,
        ];
        try {
            $path = $privateRoot . '/upstox-session.json';
            $stat = @lstat($path);
            if (!is_string($expectedUserId) || strlen($expectedUserId) > 128
                || $stat === false || !is_file($path) || is_link($path)
                || ($stat['mode'] & 0077) !== 0 || $stat['size'] < 80
                || $stat['size'] > 16384
                || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())) {
                return $result;
            }
            $file = file_get_contents($path);
            if (!is_string($file)) return $result;
            $session = json_decode($file, true, 12, JSON_THROW_ON_ERROR);
            if (!is_array($session) || ($session['schema'] ?? null) !== 'QSYN-UPSTOX-AUTH-SESSION/1'
                || ($session['broker'] ?? null) !== 'upstox'
                || ($session['user_id'] ?? null) !== $expectedUserId
                || ($session['order_routing_enabled'] ?? null) !== false
                || ($session['display_entitlement_verified'] ?? null) !== false
                || ($session['retention_entitlement_verified'] ?? null) !== false) {
                $result['diagnostic_code'] = 'UPSTOX_STORED_ACCOUNT_MISMATCH';
                return $result;
            }
            $token = $session['access_token'] ?? null;
            if (!is_string($token) || strlen($token) < 20 || strlen($token) > 8192
                || preg_match('/^[A-Za-z0-9._~+\/=\-]+$/D', $token) !== 1) {
                return $result;
            }

            $response = $transport !== null
                ? $transport(self::PROFILE, $token) : self::getProfile($token);
            // Expected test transport and default live cURL share the same
            // bounded, provider-shaped status/data contract.
            if (!is_array($response)) {
                $result['diagnostic_code'] = 'UPSTOX_INVALID_PROVIDER_RESPONSE';
                return $result;
            }
            $http = $response['http_status'] ?? null;
            if ($http === 401 || $http === 403) {
                $result['diagnostic_code'] = 'UPSTOX_TOKEN_EXPIRED_OR_REVOKED';
                return $result;
            }
            if ($http !== 200) {
                $result['diagnostic_code'] = 'UPSTOX_PROFILE_PROVIDER_UNAVAILABLE';
                return $result;
            }
            if (!is_array($response['body'] ?? null)
                || ($response['body']['status'] ?? null) !== 'success'
                || !is_array($response['body']['data'] ?? null)) {
                $result['diagnostic_code'] = 'UPSTOX_INVALID_PROVIDER_RESPONSE';
                return $result;
            }
            $profile = $response['body']['data'];
            if (($profile['user_id'] ?? null) !== $expectedUserId) {
                $result['diagnostic_code'] = 'UPSTOX_PROFILE_ACCOUNT_MISMATCH';
                return $result;
            }
            if (($profile['is_active'] ?? null) !== true) {
                $result['diagnostic_code'] = 'UPSTOX_ACCOUNT_INACTIVE';
                return $result;
            }
            $result['session_verified'] = true;
            $result['profile_account_matches'] = true;
            $result['provider_account_active'] = true;
            $result['status'] = 'verified_now';
            $result['diagnostic_code'] = 'UPSTOX_PROFILE_VERIFIED_NOW';
            return $result;
        } catch (\Throwable) {
            // Never reflect exception messages: they can embed tokens or paths.
            $result['diagnostic_code'] = 'UPSTOX_PROFILE_TRANSPORT_ERROR';
            return $result;
        }
    }

    private static function getProfile(string $token): array
    {
        if (!function_exists('curl_init')) throw new \RuntimeException('curl_missing');
        $curl = curl_init(self::PROFILE);
        if ($curl === false) throw new \RuntimeException('transport_unavailable');
        try {
            curl_setopt_array($curl, [
                CURLOPT_HTTPGET => true,
                CURLOPT_HTTPHEADER => [
                    'Accept: application/json',
                    'Authorization: Bearer ' . $token,
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 4,
                CURLOPT_TIMEOUT => 9,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            ]);
            $body = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
            if (!is_string($body) || strlen($body) > 16384) {
                throw new \RuntimeException('profile_response_invalid');
            }
            $decoded = json_decode($body, true, 12, JSON_THROW_ON_ERROR);
            return ['http_status' => $status, 'body' => $decoded];
        } finally {
            curl_close($curl);
        }
    }
}

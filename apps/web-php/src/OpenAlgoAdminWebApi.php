<?php
declare(strict_types=1);

namespace QSYN\Broker;

use QSYN\Admin\RustAdmin;

/**
 * Operator-password protected, read-only web bridge to registered OpenAlgo.
 * Never accepts browser-supplied host, port, tenant, API key or OAuth code.
 * Never activates order APIs, market data or processes.
 */
final class OpenAlgoAdminWebApi
{
    private const SCHEMA = 'QSYN-OPENALGO-ADMIN-READINESS/1';

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(string $operation, array $server): array
    {
        if (getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1'
            || getenv('QSYN_CONTROL_ENABLED') === '0') {
            return [503, ['error' => 'broker_operator_readiness_disabled']];
        }
        if (!RustAdmin::originAllowed($server)) {
            return [403, ['error' => 'secure_same_origin_required']];
        }
        RustAdmin::boot();
        $expected = $operation === 'accounts' ? 'GET' : 'POST';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $expected) {
            return [405, ['error' => 'method_not_allowed']];
        }
        if (!RustAdmin::authenticated()) {
            return [401, ['error' => 'admin_login_required']];
        }

        $body = [];
        if ($expected === 'POST') {
            if (preg_match('~^application/json(?:\s*;|$)~i',
                    (string)($server['CONTENT_TYPE'] ?? '')) !== 1) {
                return [415, ['error' => 'json_required']];
            }
            $raw = file_get_contents('php://input', false, null, 0, 1025);
            if (!is_string($raw) || strlen($raw) > 1024) {
                return [413, ['error' => 'request_too_large']];
            }
            try {
                $body = json_decode($raw, true, 6, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                return [400, ['error' => 'invalid_json']];
            }
            if (!is_array($body) || array_is_list($body)
                || array_keys($body) !== ['account_id']
                || !is_string($body['account_id'])
                || preg_match('/^[A-Za-z0-9._-]{1,80}$/D', $body['account_id']) !== 1) {
                return [422, ['error' => 'invalid_account_selection']];
            }
            if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
                return [403, ['error' => 'csrf_invalid']];
            }
        } elseif ($operation !== 'accounts') {
            return [404, ['error' => 'not_found']];
        }

        try {
            $runtime = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2) . '/runtime');
            $registry = (string)(getenv('QSYN_OPENALGO_REGISTRY_FILE')
                ?: rtrim($runtime, '/') . '/openalgo-registry.json');
            if (!is_file($registry) && !is_link($registry) && $operation === 'accounts') {
                // No installed OpenAlgo profile is normal for a first launch.
                // Avoid repeated 503s and report the actionable setup state.
                $setup = OpenAlgoAdminSetup::state();
                return [200, [
                    'schema' => self::SCHEMA,
                    'accounts' => [],
                    'csrf' => RustAdmin::csrf(),
                    'configuration_state' => 'not_provisioned',
                    'setup_available' => $setup['available'],
                    'setup_mode' => $setup['mode'],
                    'trading_enabled_in_qsyn' => false,
                    'market_entitlement_verified' => false,
                    'broker_identity_verified' => false,
                    'upstream_order_permissions_verified' => false,
                ]];
            }
            $accounts = PrivateBrokerRegistry::loadForAdminWeb($registry);
            $loginFile = (string)(getenv('QSYN_OPENALGO_LOGIN_URLS_FILE')
                ?: rtrim($runtime, '/') . '/openalgo-login-urls.json');
            // Missing mapping = no login button. Present but unsafe = hard error.
            $urls = (is_file($loginFile) || is_link($loginFile))
                ? OpenAlgoBrokerConnectionsApi::configuredLoginUrls($loginFile) : [];
        } catch (\Throwable) {
            return [503, ['error' => 'private_openalgo_not_configured']];
        }

        if ($operation === 'accounts') {
            $list = [];
            foreach ($accounts as $account) {
                $list[] = [
                    'account_id' => $account['account_id'],
                    'broker' => $account['broker'],
                    'login_available' => isset($urls[$account['account_id']]),
                    'session_state' => 'not_checked',
                ];
            }
            return [200, [
                'schema' => self::SCHEMA,
                'accounts' => $list,
                'csrf' => RustAdmin::csrf(),
                'configuration_state' => 'registered',
                'setup_available' => false,
                'trading_enabled_in_qsyn' => false,
                'market_entitlement_verified' => false,
                'broker_identity_verified' => false,
                'upstream_order_permissions_verified' => false,
            ]];
        }
        $id = $body['account_id'];
        if (!isset($accounts[$id])) {
            return [404, ['error' => 'account_not_found']];
        }
        $account = $accounts[$id];
        if ($operation === 'connect') {
            if (!isset($urls[$id])) {
                return [409, ['error' => 'approved_openalgo_login_not_provisioned']];
            }
            return [200, [
                'schema' => self::SCHEMA,
                'account_id' => $id,
                'broker' => $account['broker'],
                'login_url' => $urls[$id],
                'session_state' => 'awaiting_upstream_login',
                'trading_enabled_in_qsyn' => false,
            ]];
        }
        if ($operation === 'inspect') {
            $responding = self::ping($account);
            return [200, [
                'schema' => self::SCHEMA,
                'account_id' => $id,
                'broker' => $account['broker'],
                'session_state' => $responding
                    ? 'openalgo_session_responding' : 'unavailable_or_expired',
                'openalgo_application_session_responding' => $responding,
                'broker_identity_verified' => false,
                'broker_oauth_callback_verified' => false,
                'market_entitlement_verified' => false,
                'live_feed_verified' => false,
                'upstream_order_permissions_verified' => false,
                'trading_enabled_in_qsyn' => false,
            ]];
        }
        return [404, ['error' => 'not_found']];
    }

    /** Only pinned loopback OpenAlgo authenticated ping is permitted. */
    private static function ping(array $account): bool
    {
        try {
            $port = $account['rest_port'];
            $key = PrivateBrokerRegistry::credential($account);
            $ctx = stream_context_create(['http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\n",
                'content' => json_encode(['apikey' => $key], JSON_THROW_ON_ERROR),
                'timeout' => 2,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 0,
            ]]);
            $reply = @file_get_contents("http://127.0.0.1:{$port}/api/v1/ping",
                false, $ctx, 0, 8193);
            $headers = $http_response_header ?? [];
            if (!is_string($reply) || strlen($reply) > 8192
                || !preg_match('/^HTTP\/\S+\s+200(?:\s|$)/',
                    (string)($headers[0] ?? ''))) return false;
            $response = json_decode($reply, true, 12, JSON_THROW_ON_ERROR);
            return is_array($response)
                && ($response['status'] ?? null) === 'success'
                && ($response['data']['broker'] ?? null) === $account['broker']
                && ($response['data']['message'] ?? null) === 'pong';
        } catch (\Throwable) {
            return false;
        }
    }
}

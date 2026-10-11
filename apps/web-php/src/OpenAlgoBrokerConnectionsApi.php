<?php
declare(strict_types=1);

namespace QSYN\Broker;

use QSYN\Identity\FileUserRepository;
use QSYN\Identity\IdentityApi;
use QSYN\Identity\UserSession;
use QSYN\Storage\FileStore;

/**
 * Opt-in, PRIVATE DEVELOPMENT ONLY bridge to isolated OpenAlgo instances.
 *
 * Broker credentials and OAuth stay exclusively inside upstream OpenAlgo.
 * Connect only reveals an operator-owned, HTTPS login page after authenticating
 * the QSYN user, matching account ownership, checking CSRF and role. It does
 * not claim broker user/UCC verification, market licenses or live execution.
 */
final class OpenAlgoBrokerConnectionsApi
{
    private const SCHEMA = 'QSYN-OPENALGO-CONNECTIONS/1';

    public static function dispatch(string $operation, array $server, array $query = []): array
    {
        if ($operation === 'catalog') {
            if (($server['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
                return [405, ['error' => 'method_not_allowed']];
            }
            return [200, [
                'schema' => self::SCHEMA,
                'brokers' => PrivateBrokerRegistry::supportedBrokers(),
                'source' => 'openalgo_broker_plugins',
                'connections_public' => false,
                'trading_enabled' => false,
            ]];
        }

        $root = IdentityApi::privateRoot();
        if ($root === null || getenv('QSYN_OPENALGO_BROWSER_CONNECT_ENABLED') !== '1'
            || getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') {
            return [503, ['error' => 'private_broker_connections_disabled']];
        }
        if (!UserSession::boot($server)) {
            return [403, ['error' => 'secure_transport_required']];
        }
        $expectedMethod = $operation === 'connect' ? 'POST' : 'GET';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $expectedMethod) {
            return [405, ['error' => 'method_not_allowed']];
        }
        $principal = UserSession::principal(new FileUserRepository(new FileStore($root)));
        if ($principal === null) {
            return [401, ['error' => 'unauthorized']];
        }
        $tenant = (string) $principal['tenant_id'];
        $owner = (string) $principal['user_id'];
        if (!UserSession::authorized($principal, $tenant, 'viewer')) {
            return [403, ['error' => 'forbidden']];
        }

        // Never accept tenant, owner, port, upstream URL or API key from HTTP.
        $registryPath = (string) (getenv('QSYN_OPENALGO_REGISTRY_FILE') ?: '');
        try {
            $accounts = PrivateBrokerRegistry::loadForPrivateBrowser($registryPath);
            $links = self::loginLinks((string) (getenv('QSYN_OPENALGO_LOGIN_URLS_FILE') ?: ''));
        } catch (\Throwable) {
            return [503, ['error' => 'private_broker_registry_unavailable']];
        }
        $mine = array_filter($accounts, static fn (array $item): bool =>
            $item['tenant_id'] === $tenant && $item['owner_user_id'] === $owner);
        $canConnect = UserSession::authorized($principal, $tenant, 'member');
        if ($operation === 'accounts') {
            return [200, [
                'schema' => self::SCHEMA,
                'profile' => 'private_development_only',
                'accounts' => array_values(array_map(static fn (array $item): array => [
                    'account_id' => $item['account_id'],
                    'broker' => $item['broker'],
                    'login_available' => $canConnect && isset($links[$item['account_id']]),
                    'session_state' => 'not_checked',
                ], $mine)),
                'csrf' => UserSession::csrf(),
                'trading_enabled' => false,
                'entitlement_verified' => false,
                'broker_identity_verified' => false,
            ]];
        }

        if ($operation === 'connect') {
            if (!$canConnect) return [403, ['error' => 'forbidden']];
            if (!UserSession::originAllowed($server)) {
                return [403, ['error' => 'origin_not_allowed']];
            }
            if (preg_match('~^application/json(?:\s*;|$)~i', (string) ($server['CONTENT_TYPE'] ?? '')) !== 1) {
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
                || array_keys($body) !== ['account_id']) {
                return [422, ['error' => 'invalid_connect_request']];
            }
            if (!UserSession::verifyCsrf((string) ($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
                return [403, ['error' => 'csrf_invalid']];
            }
            $id = $body['account_id'];
            if (!is_string($id) || !isset($mine[$id])) {
                return [404, ['error' => 'broker_account_not_found']];
            }
            if (!isset($links[$id])) {
                return [409, ['error' => 'private_openalgo_login_not_provisioned']];
            }
            // Upstream OpenAlgo login owns its separate authenticated session.
            // User must return to QSYN and request a fresh sanitized ping.
            return [200, [
                'schema' => self::SCHEMA, 'account_id' => $id,
                'login_url' => $links[$id], 'connection_status' => 'awaiting_upstream_login',
                'trading_enabled' => false,
            ]];
        }

        if ($operation === 'status') {
            $id = $query['account_id'] ?? null;
            if (!is_string($id) || strlen($id) > 80 || !isset($mine[$id])) {
                return [404, ['error' => 'broker_account_not_found']];
            }
            $responding = self::ping($mine[$id]);
            return [200, [
                'schema' => self::SCHEMA, 'account_id' => $id,
                'broker' => $mine[$id]['broker'],
                'session_state' => $responding ? 'openalgo_session_responding' : 'unavailable_or_expired',
                'broker_identity_verified' => false,
                'market_entitlement_verified' => false,
                'trading_enabled' => false,
            ]];
        }
        return [404, ['error' => 'not_found']];
    }

    /** Separate 0600 operator-managed mapping. No browser-supplied targets. */
    private static function loginLinks(string $path): array
    {
        if ($path === '') return [];
        $raw = file_get_contents(PrivateBrokerRegistry::privateFile($path));
        $data = json_decode((string) $raw, true, 12, JSON_THROW_ON_ERROR);
        if (!is_array($data) || ($data['schema'] ?? '') !== 'QSYN-OPENALGO-LOGIN-URLS/1'
            || !is_array($data['accounts'] ?? null) || !array_is_list($data['accounts'])
            || count($data['accounts']) > 16) {
            throw new \RuntimeException('invalid_openalgo_login_registry');
        }
        $links = [];
        foreach ($data['accounts'] as $item) {
            if (!is_array($item) || array_keys($item) !== ['account_id', 'login_url']
                || !is_string($item['account_id'] ?? null)
                || !preg_match('/^[A-Za-z0-9._-]{1,80}$/D', $item['account_id'])
                || !is_string($item['login_url'] ?? null)) {
                throw new \RuntimeException('invalid_openalgo_login_mapping');
            }
            $url = $item['login_url'];
            $parts = parse_url($url);
            $host = is_array($parts) ? ($parts['host'] ?? '') : '';
            if (strlen($url) > 350 || !is_array($parts)
                || ($parts['scheme'] ?? null) !== 'https'
                || ($parts['path'] ?? null) !== '/login'
                || isset($parts['user'], $parts['pass']) || isset($parts['port'])
                || isset($parts['query']) || isset($parts['fragment'])
                || !is_string($host)
                || preg_match('/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,251}[a-zA-Z0-9]$/D', $host) !== 1
                || !str_contains($host, '.') || filter_var($host, FILTER_VALIDATE_IP)
                || isset($links[$item['account_id']])) {
                throw new \RuntimeException('unsafe_openalgo_login_url');
            }
            $links[$item['account_id']] = $url;
        }
        return $links;
    }

    /** Fixed authenticated read-only /ping; never forwards untrusted provider JSON. */
    private static function ping(array $account): bool
    {
        try {
            $key = PrivateBrokerRegistry::credential($account);
            $port = $account['rest_port'];
            $body = json_encode(['apikey' => $key], JSON_THROW_ON_ERROR);
            $ctx = stream_context_create(['http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\n",
                'content' => $body,
                'timeout' => 2,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 0,
            ]]);
            $response = @file_get_contents(
                "http://127.0.0.1:{$port}/api/v1/ping", false, $ctx, 0, 8193
            );
            $headers = $http_response_header ?? [];
            if (!is_string($response) || strlen($response) > 8192
                || !preg_match('/^HTTP\/\S+\s+200(?:\s|$)/', (string) ($headers[0] ?? ''))) {
                return false;
            }
            $json = json_decode($response, true, 12, JSON_THROW_ON_ERROR);
            return is_array($json) && ($json['status'] ?? null) === 'success'
                && ($json['data']['broker'] ?? null) === $account['broker']
                && ($json['data']['message'] ?? null) === 'pong';
        } catch (\Throwable) {
            return false;
        }
    }
}

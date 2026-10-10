<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use InvalidArgumentException;
use QSYN\Identity\FileUserRepository;
use QSYN\Identity\IdentityApi;
use QSYN\Identity\UserSession;
use QSYN\Storage\FileStore;

/**
 * Development-private session -> signed Rust chart grant.
 *
 * Does NOT authenticate a broker or attest exchange rights on its own.
 * Rust still checks the CURRENT operator-approved rights file on connect
 * and every second; the issued token is scoped to one user, account and key.
 */
final class PrivateChartGrantApi
{
    private const SCHEMA = 'QSYN-PRIVATE-CHART-ENTITLEMENT/1';
    private const MAX_DURATION_MS = 30000;

    private static function eligibleRoot(): ?string
    {
        if (getenv('QSYN_PRIVATE_CHART_GRANTS_ENABLED') !== '1'
            || getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') {
            return null;
        }
        return IdentityApi::privateRoot();
    }

    private static function privateFile(string $root, string $envName, int $limit): string
    {
        $provided = (string) (getenv($envName) ?: '');
        if (!str_starts_with($provided, '/') || str_contains($provided, '/..')
            || is_link($provided)) {
            throw new InvalidArgumentException('private_chart_config_unavailable');
        }
        $actual = realpath($provided);
        if ($actual === false || $actual !== $provided || !is_file($actual)
            || is_link($actual) || dirname($actual) !== $root || filesize($actual) > $limit) {
            throw new InvalidArgumentException('private_chart_config_unavailable');
        }
        clearstatcache(true, $actual);
        $mode = fileperms($actual);
        if ($mode === false || ($mode & 0077) !== 0
            || (function_exists('posix_geteuid') && fileowner($actual) !== posix_geteuid())) {
            throw new InvalidArgumentException('private_chart_config_unavailable');
        }
        return $actual;
    }

    private static function ident(mixed $value): bool
    {
        return is_string($value) && strlen($value) >= 1 && strlen($value) <= 128
            && preg_match('/^[A-Za-z0-9_.:|-]+$/D', $value) === 1;
    }

    private static function validRights(string $root, array $principal, string $account, string $instrument, int $now): ?array
    {
        try {
            $path = self::privateFile($root, 'QSYN_PRIVATE_CHART_RIGHTS_FILE', 8192);
            $input = file_get_contents($path);
            if (!is_string($input)) return null;
            $rights = json_decode($input, true, 16, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            return null;
        }
        if (!is_array($rights) || array_is_list($rights)
            || count($rights) !== 10
            || ($rights['schema'] ?? null) !== self::SCHEMA
            || ($rights['tenant'] ?? null) !== $principal['tenant_id']
            || ($rights['owner'] ?? null) !== $principal['user_id']
            || ($rights['account'] ?? null) !== $account
            || ($rights['broker'] ?? null) !== 'upstox'
            || ($rights['can_display_to_this_user'] ?? null) !== true
            || ($rights['broker_session_verified'] ?? null) !== true
            || !self::ident($rights['license_id'] ?? null)
            || !is_array($rights['instruments'] ?? null)
            || !array_is_list($rights['instruments'])
            || count($rights['instruments']) < 1 || count($rights['instruments']) > 8
            || !in_array($instrument, $rights['instruments'], true)
            || !is_int($rights['valid_until_ms'] ?? null)
            || $rights['valid_until_ms'] <= $now + self::MAX_DURATION_MS) {
            return null;
        }
        foreach (['tenant', 'owner', 'account', 'broker'] as $field) {
            if (!self::ident($rights[$field] ?? null)) return null;
        }
        foreach ($rights['instruments'] as $key) {
            if (!self::ident($key)) return null;
        }
        return $rights;
    }

    private static function issue(array $rights, string $instrument, string $root, int $now): ?array
    {
        try {
            $secretPath = self::privateFile($root, 'QSYN_PRIVATE_CHART_SIGNING_KEY_FILE', 64);
            $secret = file_get_contents($secretPath);
        } catch (\Throwable) {
            return null;
        }
        if (!is_string($secret) || strlen($secret) !== 32) return null;
        // Keep the exact Rust ChartGrant serialization field order, integer
        // timestamps, audience, and base64url(HMAC-SHA256(payload)).
        $claim = [
            'version' => 1,
            'tenant' => $rights['tenant'],
            'account' => $rights['account'],
            'owner' => $rights['owner'],
            'broker' => $rights['broker'],
            'instrument' => $instrument,
            'license_id' => $rights['license_id'],
            'audience' => 'qsyn-private-chart',
            'issued_ms' => $now,
            'expires_ms' => $now + self::MAX_DURATION_MS,
        ];
        $payload = json_encode($claim, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $encode = static fn (string $bytes): string => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
        $ticket = $encode($payload) . '.' . $encode(hash_hmac('sha256', $payload, $secret, true));
        if (strlen($ticket) > 2048) return null;
        return ['ticket' => $ticket, 'expires_ms' => $claim['expires_ms']];
    }

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(array $server): array
    {
        $root = self::eligibleRoot();
        if ($root === null) {
            return [503, ['error' => 'private_chart_grants_disabled']];
        }
        if (!UserSession::boot($server)) {
            return [403, ['error' => 'secure_transport_required']];
        }
        if (($server['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
            return [405, ['error' => 'method_not_allowed']];
        }
        $principal = UserSession::principal(new FileUserRepository(new FileStore($root)));
        if ($principal === null) {
            return [401, ['error' => 'unauthorized']];
        }
        if (!UserSession::authorized($principal, (string) $principal['tenant_id'], 'viewer')) {
            return [403, ['error' => 'forbidden']];
        }
        if (!UserSession::originAllowed($server)) {
            return [403, ['error' => 'origin_not_allowed']];
        }
        if (!preg_match('~^application/json(?:\s*;|$)~i', (string) ($server['CONTENT_TYPE'] ?? ''))) {
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
        if (!is_array($body) || array_is_list($body) || count($body) !== 2
            || !isset($body['account_id'], $body['instrument'])) {
            return [422, ['error' => 'invalid_chart_request']];
        }
        if (!UserSession::verifyCsrf((string) ($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error' => 'csrf_invalid']];
        }
        $account = $body['account_id'];
        $instrument = $body['instrument'];
        if (!self::ident($account) || !self::ident($instrument)) {
            return [422, ['error' => 'invalid_chart_request']];
        }
        $now = (int) floor(microtime(true) * 1000);
        $rights = self::validRights($root, $principal, $account, $instrument, $now);
        if ($rights === null) {
            return [403, ['error' => 'chart_entitlement_not_verified']];
        }
        $issued = self::issue($rights, $instrument, $root, $now);
        if ($issued === null) {
            return [503, ['error' => 'private_chart_signing_unavailable']];
        }
        return [200, [
            'schema' => 'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1',
            'ticket' => $issued['ticket'],
            'expires_ms' => $issued['expires_ms'],
            'account_id' => $account,
            'instrument' => $instrument,
            'transport' => 'operator_private_wss_only',
            'trading_enabled' => false,
            'public_redistribution_allowed' => false,
        ]];
    }
}

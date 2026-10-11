<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use QSYN\Admin\RustAdmin;

/**
 * Single-operator private index chart grants. Separate from development/mock
 * accounts. A valid QSYN administrator session is necessary but NEVER proof
 * of exchange display rights: independently approved current private rights
 * and explicit operator-to-account binding are required on every issuance.
 */
final class OperatorIndexChartGrantApi
{
    private const RESPONSE = 'QSYN-PRIVATE-CHART-GRANT-RESPONSE/1';
    private const RIGHTS = 'QSYN-PRIVATE-CHART-ENTITLEMENT/1';
    private const TTL = 30000;

    private static function identifier(mixed $value): bool
    {
        return is_string($value) && preg_match('/\A[A-Za-z0-9_.:-]{1,128}\z/D', $value) === 1;
    }

    private static function indexKey(mixed $value): bool
    {
        return is_string($value) && strlen($value) <= 128
            && preg_match('/\A(?:NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}\z/D', $value) === 1;
    }

    private static function enabled(): bool
    {
        return getenv('QSYN_PRIVATE_OPERATOR_CHART_ENABLED') === '1'
            && getenv('QSYN_PRIVATE_CHART_GRANTS_ENABLED') === '1'
            && getenv('QSYN_TRADING_ENABLED') !== '1'
            && getenv('QSYN_ENABLE_LIVE_TRADING') !== '1'
            && getenv('QSYN_CONTROL_ENABLED') !== '0';
    }

    /** The ingress hostname must be selected independently by the operator. */
    private static function binding(array $server): ?array
    {
        $host = (string)($server['HTTP_HOST'] ?? '');
        $expectedHost = (string)(getenv('QSYN_PRIVATE_OPERATOR_CHART_HOST') ?: '');
        $tenant = getenv('QSYN_PRIVATE_OPERATOR_CHART_TENANT');
        $owner = getenv('QSYN_PRIVATE_OPERATOR_CHART_OWNER');
        $account = getenv('QSYN_PRIVATE_OPERATOR_CHART_ACCOUNT');
        if ($host === '' || $expectedHost === '' || $host !== $expectedHost
            || preg_match('/\A[A-Za-z0-9.-]+(?::[0-9]{1,5})?\z/D', $host) !== 1
            || !self::identifier($tenant) || !self::identifier($owner)
            || !self::identifier($account)) {
            return null;
        }
        return ['tenant'=>$tenant, 'owner'=>$owner, 'account'=>$account];
    }

    private static function root(): ?string
    {
        $configured = getenv('QSYN_RUNTIME_DIR');
        if (!is_string($configured) || !str_starts_with($configured, '/')
            || str_contains($configured, '/..') || is_link($configured)) {
            return null;
        }
        $runtime = realpath($configured);
        if ($runtime === false || $runtime === '/' || $runtime !== $configured) return null;
        $candidate = $runtime . '/upstox-private';
        clearstatcache(true, $candidate);
        $mode = @fileperms($candidate);
        if (!is_dir($candidate) || is_link($candidate) || $mode === false
            || ($mode & 0077) !== 0
            || (function_exists('posix_geteuid') && @fileowner($candidate) !== posix_geteuid())) {
            return null;
        }
        return $candidate;
    }

    private static function file(string $root, string $env, int $max): ?string
    {
        $input = getenv($env);
        if (!is_string($input) || !str_starts_with($input, '/')
            || str_contains($input, '/..') || is_link($input)
            || dirname($input) !== $root || realpath($input) !== $input) {
            return null;
        }
        clearstatcache(true, $input);
        $mode = @fileperms($input);
        $size = @filesize($input);
        if (!is_file($input) || is_link($input) || !is_readable($input)
            || $mode === false || ($mode & 0077) !== 0
            || $size === false || $size < 1 || $size > $max
            || (function_exists('posix_geteuid') && @fileowner($input) !== posix_geteuid())) {
            return null;
        }
        return $input;
    }

    private static function rights(string $root, array $binding, string $key, int $now): ?array
    {
        $path = self::file($root, 'QSYN_PRIVATE_CHART_RIGHTS_FILE', 8192);
        if ($path === null) return null;
        try {
            $source = json_decode((string)file_get_contents($path), true, 16, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            return null;
        }
        if (!is_array($source) || array_is_list($source)
            || count($source) !== 10 || ($source['schema'] ?? null) !== self::RIGHTS
            || ($source['broker'] ?? null) !== 'upstox'
            || ($source['tenant'] ?? null) !== $binding['tenant']
            || ($source['owner'] ?? null) !== $binding['owner']
            || ($source['account'] ?? null) !== $binding['account']
            || !self::identifier($source['license_id'] ?? null)
            || ($source['can_display_to_this_user'] ?? false) !== true
            || ($source['broker_session_verified'] ?? false) !== true
            || !is_int($source['valid_until_ms'] ?? null)
            || $source['valid_until_ms'] <= $now + self::TTL
            || !is_array($source['instruments'] ?? null)
            || !array_is_list($source['instruments'])
            || count($source['instruments']) < 1
            || count($source['instruments']) > 8
            || !in_array($key, $source['instruments'], true)) {
            return null;
        }
        // An operator-only index grant must not bless arbitrary rights entries.
        foreach ($source['instruments'] as $instrument) {
            if (!self::indexKey($instrument)) return null;
        }
        return $source;
    }

    private static function issue(string $root, array $rights, string $key, int $now): ?array
    {
        $path = self::file($root, 'QSYN_PRIVATE_CHART_SIGNING_KEY_FILE', 64);
        if ($path === null) return null;
        $secret = @file_get_contents($path);
        if (!is_string($secret) || strlen($secret) !== 32) return null;
        // Rust ChartGrant field ordering is a verified cross-language contract.
        $claims = [
            'version'=>1, 'tenant'=>$rights['tenant'], 'account'=>$rights['account'],
            'owner'=>$rights['owner'], 'broker'=>'upstox', 'instrument'=>$key,
            'license_id'=>$rights['license_id'], 'audience'=>'qsyn-private-chart',
            'issued_ms'=>$now, 'expires_ms'=>$now + self::TTL,
        ];
        $body = json_encode($claims, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $base = static fn(string $raw): string => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
        $token = $base($body) . '.' . $base(hash_hmac('sha256', $body, $secret, true));
        return strlen($token) <= 2048 ? ['ticket'=>$token, 'expires_ms'=>$claims['expires_ms']] : null;
    }

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(array $server, string $operation): array
    {
        if (!in_array($operation, ['access', 'grant'], true)) {
            return [404, ['error'=>'not_found']];
        }
        $method = $operation === 'access' ? 'GET' : 'POST';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $method) {
            return [405, ['error'=>'method_not_allowed']];
        }
        if (!self::enabled()) {
            return [503, ['error'=>'private_operator_chart_disabled']];
        }
        if (!RustAdmin::originAllowed($server)) {
            return [403, ['error'=>'secure_same_origin_required']];
        }
        RustAdmin::boot();
        if (!RustAdmin::authenticated()) {
            return [401, ['error'=>'admin_login_required']];
        }
        $binding = self::binding($server);
        $root = self::root();
        if ($binding === null || $root === null) {
            return [503, ['error'=>'operator_private_scope_not_provisioned']];
        }
        if ($operation === 'access') {
            return [200, [
                'schema'=>'QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1',
                'authenticated'=>true, 'profile'=>'operator-admin',
                'account_id'=>$binding['account'], 'csrf'=>RustAdmin::csrf(),
                'private_rights_attested'=>false, 'live_feed_verified'=>false,
                'trading_enabled'=>false,
            ]];
        }
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error'=>'csrf_invalid']];
        }
        if (preg_match('~^application/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE'] ?? '')) !== 1) {
            return [415, ['error'=>'json_required']];
        }
        $raw = file_get_contents('php://input', false, null, 0, 1025);
        if (!is_string($raw) || strlen($raw) > 1024) {
            return [413, ['error'=>'request_too_large']];
        }
        try {
            $body = json_decode($raw, true, 6, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            return [400, ['error'=>'invalid_json']];
        }
        if (!is_array($body) || array_is_list($body)
            || count($body) !== 2 || !isset($body['account_id'],$body['instrument'])
            || $body['account_id'] !== $binding['account']
            || !self::indexKey($body['instrument'])) {
            return [422, ['error'=>'invalid_chart_request']];
        }
        $now = (int)floor(microtime(true)*1000);
        $rights = self::rights($root, $binding, $body['instrument'], $now);
        if ($rights === null) {
            return [403, ['error'=>'chart_entitlement_not_verified']];
        }
        $grant = self::issue($root, $rights, $body['instrument'], $now);
        if ($grant === null) {
            return [503, ['error'=>'private_chart_signing_unavailable']];
        }
        return [200, [
            'schema'=>self::RESPONSE,
            'ticket'=>$grant['ticket'], 'expires_ms'=>$grant['expires_ms'],
            'account_id'=>$binding['account'], 'instrument'=>$body['instrument'],
            'transport'=>'operator_private_wss_only', 'trading_enabled'=>false,
            'public_redistribution_allowed'=>false,
        ]];
    }
}

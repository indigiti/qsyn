<?php
declare(strict_types=1);

namespace QSYN\Identity;

use QSYN\Storage\FileStore;
use QSYN\Audit\FileMockAuditLog;

/**
 * Development/test API boundary. Disabled without explicit private storage,
 * secure transport and the deliberate QSYN_IDENTITY_ENABLED opt-in.
 *
 * It cannot create accounts, accept arbitrary tenant authority, place orders
 * or control the Rust process. Only offline fixture tools/tests create users.
 */
final class IdentityApi
{
    public static function privateRoot(): ?string
    {
        if (getenv('QSYN_IDENTITY_ENABLED') !== '1'
            || !in_array(getenv('QSYN_ENV'), ['test', 'development'], true)) {
            return null;
        }
        // Default to real loopback-only test traffic; development HTTPS
        // requires an exact private ingress hostname and explicit opt-in.
        // These environment assertions do not substitute for VPN/firewall
        // isolation, which must be independently verified before rollout.
        if (getenv('QSYN_ENV') === 'test') {
            if (!UserSession::loopbackTest($_SERVER)) {
                return null;
            }
        } else {
            $configuredHost = (string) (getenv('QSYN_IDENTITY_ALLOWED_HOST') ?: '');
            $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
            if (getenv('QSYN_PRIVATE_STAGING_CONFIRMED') !== '1'
                || $configuredHost === '' || $host !== $configuredHost
                || preg_match('/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/D', $host) !== 1
                || !UserSession::secureRequest($_SERVER)) {
                return null;
            }
        }
        $configured = (string) (getenv('QSYN_IDENTITY_STORAGE_DIR') ?: '');
        if (!str_starts_with($configured, '/') || str_contains($configured, '/..')
            || !is_dir($configured) || is_link($configured)) {
            return null;
        }
        $root = realpath($configured);
        $public = realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''));
        clearstatcache(true, $configured);
        $mode = fileperms($configured);
        if ($root === false || $root === '/' || $mode === false
            || ($mode & 0007) !== 0 || ($mode & 0020) !== 0
            || ($public !== false && ($root === $public || str_starts_with($root, $public . '/')))) {
            return null;
        }
        return $root;
    }

    /**
     * @return array{0: int, 1: array<string, mixed>}
     */
    public static function dispatch(string $operation, array $server): array
    {
        $private = self::privateRoot();
        if ($private === null) {
            return [503, ['error' => 'identity_not_enabled']];
        }
        if (!UserSession::boot($server)) {
            return [403, ['error' => 'secure_transport_required']];
        }
        $expected = in_array($operation, ['state', 'me'], true) ? 'GET' : 'POST';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $expected) {
            return [405, ['error' => 'method_not_allowed']];
        }
        $users = new FileUserRepository(new FileStore($private));
        $principal = UserSession::principal($users);
        if ($operation === 'state') {
            return [200, [
                'authenticated' => $principal !== null,
                'csrf' => UserSession::csrf(),
                'user' => $principal,
                'profile' => 'mock-only',
            ]];
        }
        if ($operation === 'me') {
            return $principal === null
                ? [401, ['error' => 'unauthorized']]
                : [200, ['user' => $principal]];
        }

        if (!UserSession::originAllowed($server)) {
            return [403, ['error' => 'origin_not_allowed']];
        }
        if (!preg_match('~^application/json(?:\s*;|$)~i', (string) ($server['CONTENT_TYPE'] ?? ''))) {
            return [415, ['error' => 'json_required']];
        }
        $raw = file_get_contents('php://input', false, null, 0, 4097);
        if (!is_string($raw) || strlen($raw) > 4096) {
            return [413, ['error' => 'request_too_large']];
        }
        try {
            $body = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!is_array($body)) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!UserSession::verifyCsrf((string) ($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error' => 'csrf_invalid']];
        }
        if ($operation === 'logout') {
            if ($principal !== null) {
                (new FileMockAuditLog(new FileStore($private)))->record(
                    (string) $principal['tenant_id'], (string) $principal['user_id'],
                    'auth.logout', 'completed'
                );
            }
            UserSession::logout();
            return [200, ['authenticated' => false, 'csrf' => UserSession::csrf()]];
        }
        if ($operation !== 'login') {
            return [404, ['error' => 'not_found']];
        }
        if ($principal !== null) {
            return [409, ['error' => 'already_authenticated']];
        }
        $tenant = $body['tenant'] ?? null;
        $username = $body['username'] ?? null;
        $password = $body['password'] ?? null;
        if (!is_string($tenant) || !is_string($username) || !is_string($password)
            || strlen($tenant) > 64 || strlen($username) > 48 || strlen($password) > 256) {
            return [401, ['error' => 'invalid_credentials']];
        }
        // Never use client-supplied X-Forwarded-For for login rate limiting.
        // A fixed-window limit is persisted privately across PHP sessions.
        $remote = (string) ($server['REMOTE_ADDR'] ?? 'unknown');
        $throttle = new IdentityThrottle($private);
        if (!$throttle->reserve($remote, $tenant, $username)) {
            return [429, ['error' => 'too_many_attempts']];
        }
        $user = $users->verify($tenant, $username, $password);
        if ($user === null) {
            return [401, ['error' => 'invalid_credentials']];
        }
        (new FileMockAuditLog(new FileStore($private)))->record(
            (string) $user['tenant_id'], (string) $user['user_id'],
            'auth.login', 'completed'
        );
        UserSession::login($user);
        return [200, [
            'authenticated' => true,
            'csrf' => UserSession::csrf(),
            'user' => $user,
        ]];
    }
}

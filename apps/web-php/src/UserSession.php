<?php
declare(strict_types=1);

namespace QSYN\Identity;

/** Separate cookie and namespace from the privileged QSYN Rust admin. */
final class UserSession
{
    private const IDLE_SECONDS = 1200;
    private const ABSOLUTE_SECONDS = 43200;

    public static function loopbackTest(array $server): bool
    {
        $host = (string) ($server['HTTP_HOST'] ?? '');
        // PHP's built-in localhost test server exposes its bound address as
        // SERVER_NAME instead of SERVER_ADDR. Do not accept that fallback
        // under Apache/FPM where SERVER_NAME may reflect request headers.
        $listener = PHP_SAPI === 'cli-server'
            ? (string) ($server['SERVER_NAME'] ?? '')
            : (string) ($server['SERVER_ADDR'] ?? '');
        return getenv('QSYN_ENV') === 'test'
            && getenv('QSYN_ALLOW_HTTP_TEST') === '1'
            // Both endpoints must be local; a spoofed Host header is insufficient.
            && (string) ($server['REMOTE_ADDR'] ?? '') === '127.0.0.1'
            && $listener === '127.0.0.1'
            && preg_match('/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/D', $host) === 1;
    }

    public static function secureRequest(array $server): bool
    {
        return ($server['HTTPS'] ?? '') === 'on' || (string) ($server['SERVER_PORT'] ?? '') === '443';
    }

    public static function originAllowed(array $server): bool
    {
        $host = (string) ($server['HTTP_HOST'] ?? '');
        if ($host === '' || preg_match('/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/D', $host) !== 1) {
            return false;
        }
        $fetchSite = (string) ($server['HTTP_SEC_FETCH_SITE'] ?? '');
        if ($fetchSite !== '' && $fetchSite !== 'same-origin' && $fetchSite !== 'none') {
            return false;
        }
        $scheme = self::loopbackTest($server) ? 'http' : 'https';
        if ($scheme === 'https' && !self::secureRequest($server)) {
            return false;
        }
        return ($server['HTTP_ORIGIN'] ?? null) === $scheme . '://' . $host;
    }

    public static function boot(array $server): bool
    {
        if (!self::secureRequest($server) && !self::loopbackTest($server)) {
            return false;
        }
        if (session_status() === PHP_SESSION_ACTIVE) {
            // Do not accidentally share the Rust admin's PHP session.
            return session_name() === 'QSYN_USER_SESSION';
        }
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.cookie_httponly', '1');
        session_name('QSYN_USER_SESSION');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/qsyn/',
            'secure' => !self::loopbackTest($server),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        return session_start();
    }

    public static function csrf(): string
    {
        if (!isset($_SESSION['identity_csrf']) || !is_string($_SESSION['identity_csrf'])) {
            $_SESSION['identity_csrf'] = bin2hex(random_bytes(32));
        }
        return $_SESSION['identity_csrf'];
    }

    public static function verifyCsrf(string $token): bool
    {
        return strlen($token) === 64 && hash_equals(self::csrf(), $token);
    }

    public static function login(array $principal): void
    {
        session_regenerate_id(true);
        $now = time();
        $_SESSION['identity_user'] = [
            'tenant_id' => $principal['tenant_id'],
            'user_id' => $principal['user_id'],
            'issued_at' => $now,
            'last_seen' => $now,
        ];
        $_SESSION['identity_csrf'] = bin2hex(random_bytes(32));
    }

    public static function principal(UserRepository $users): ?array
    {
        $claim = $_SESSION['identity_user'] ?? null;
        if (!is_array($claim)) {
            return null;
        }
        $now = time();
        if (!isset($claim['issued_at'], $claim['last_seen'])
            || $now - (int) $claim['issued_at'] > self::ABSOLUTE_SECONDS
            || $now - (int) $claim['last_seen'] > self::IDLE_SECONDS
            || (int) $claim['issued_at'] > $now || (int) $claim['last_seen'] > $now) {
            self::logout();
            return null;
        }
        $tenant = $claim['tenant_id'] ?? null;
        $id = $claim['user_id'] ?? null;
        if (!is_string($tenant) || !is_string($id)) {
            self::logout();
            return null;
        }
        // Re-read the identity on each authenticated API call: an account
        // disabled on disk is revoked without waiting for session expiry.
        $principal = $users->findById($tenant, $id);
        if ($principal === null) {
            self::logout();
            return null;
        }
        $_SESSION['identity_user']['last_seen'] = $now;
        return $principal;
    }

    public static function authorized(array $principal, string $tenantId, string $minimumRole): bool
    {
        return ($principal['tenant_id'] ?? null) === $tenantId
            && FileUserRepository::hasRole($principal, $minimumRole);
    }

    public static function logout(): void
    {
        unset($_SESSION['identity_user']);
        session_regenerate_id(true);
        $_SESSION['identity_csrf'] = bin2hex(random_bytes(32));
    }
}

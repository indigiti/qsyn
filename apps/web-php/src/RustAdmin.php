<?php
declare(strict_types=1);

namespace QSYN\Admin;

/**
 * Isolated Phase-0 administration gate. No passwords or real broker keys stored in Git.
 * Do not enable without HTTPS and an approved restricted supervisor integration.
 */
final class RustAdmin
{
    private const IDLE_SECONDS = 1200;

    public static function configured(): bool
    {
        $hash = (string)(getenv('QSYN_ADMIN_PASSWORD_HASH') ?: '');
        return getenv('QSYN_CONTROL_ENABLED') === '1'
            && $hash !== ''
            && (password_get_info($hash)['algoName'] ?? 'unknown') !== 'unknown';
    }

    public static function boot(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.cookie_httponly', '1');
        ini_set('session.cookie_secure', '1');
        session_name('QSYN_ADMIN_SESSION');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/qsyn/',
            'secure' => true,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
        if (isset($_SESSION['qsyn_last']) && (time() - (int)$_SESSION['qsyn_last']) > self::IDLE_SECONDS) {
            self::clearAuth();
        }
    }

    public static function authenticated(): bool
    {
        return self::configured()
            && ($_SESSION['qsyn_admin'] ?? false) === true
            && isset($_SESSION['qsyn_last'])
            && (time() - (int)$_SESSION['qsyn_last']) <= self::IDLE_SECONDS;
    }

    public static function csrf(): string
    {
        if (!self::authenticated()) {
            return '';
        }
        $_SESSION['qsyn_last'] = time();
        if (!isset($_SESSION['qsyn_csrf'])) {
            $_SESSION['qsyn_csrf'] = bin2hex(random_bytes(32));
        }
        return (string)$_SESSION['qsyn_csrf'];
    }

    public static function originAllowed(array $headers): bool
    {
        $fetchSite = strtolower(trim((string)($headers['HTTP_SEC_FETCH_SITE'] ?? '')));
        if ($fetchSite !== '' && $fetchSite !== 'same-origin' && $fetchSite !== 'none') {
            return false;
        }
        $origin = trim((string)($headers['HTTP_ORIGIN'] ?? ''));
        if ($origin !== '' && $origin !== 'https://' . (string)($headers['HTTP_HOST'] ?? '')) {
            return false;
        }
        return ($headers['HTTPS'] ?? '') === 'on'
            || ($headers['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
            || getenv('QSYN_ALLOW_HTTP_TEST') === '1'; // CI only: never set on Cloudways
    }

    public static function attempt(string $password): bool
    {
        if (!self::configured()) {
            return false;
        }
        $lockUntil = (int)($_SESSION['qsyn_lock_until'] ?? 0);
        if ($lockUntil > time()) {
            return false;
        }
        $hash = (string)getenv('QSYN_ADMIN_PASSWORD_HASH');
        if (strlen($password) > 1024 || !password_verify($password, $hash)) {
            $failures = (int)($_SESSION['qsyn_failures'] ?? 0) + 1;
            $_SESSION['qsyn_failures'] = $failures;
            if ($failures >= 5) {
                $_SESSION['qsyn_lock_until'] = time() + 900;
            }
            return false;
        }
        session_regenerate_id(true);
        $_SESSION['qsyn_admin'] = true;
        $_SESSION['qsyn_last'] = time();
        $_SESSION['qsyn_csrf'] = bin2hex(random_bytes(32));
        $_SESSION['qsyn_failures'] = 0;
        $_SESSION['qsyn_lock_until'] = 0;
        return true;
    }

    public static function verifyCsrf(string $token): bool
    {
        return self::authenticated()
            && strlen($token) === 64
            && hash_equals((string)($_SESSION['qsyn_csrf'] ?? ''), $token);
    }

    public static function logout(): void
    {
        self::clearAuth();
        session_regenerate_id(true);
    }

    private static function clearAuth(): void
    {
        unset($_SESSION['qsyn_admin'], $_SESSION['qsyn_last'], $_SESSION['qsyn_csrf']);
    }
}

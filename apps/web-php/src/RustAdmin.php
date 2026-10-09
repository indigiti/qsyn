<?php
declare(strict_types=1);

namespace QSYN\Admin;

/**
 * Isolated Phase-0 administration gate. No passwords or real broker keys stored in Git.
 * Do not enable without HTTPS and a reviewed restricted execution mechanism.
 */
final class RustAdmin
{
    private const IDLE_SECONDS = 1200;

    /**
     * Password configuration belongs to the QSYN application, not PHP-FPM.
     *
     * Prefer an explicitly configured server environment when provided.
     * Otherwise read a persistent 0600 private JSON file that can be placed
     * using a trusted application file manager/SFTP (never under public_html).
     * An explicit QSYN_CONTROL_ENABLED=0 always disables administrator access.
     */
    private static function passwordHash(): string
    {
        if (getenv('QSYN_CONTROL_ENABLED') === '0') {
            return '';
        }
        $envHash = getenv('QSYN_ADMIN_PASSWORD_HASH');
        if (is_string($envHash) && $envHash !== '') {
            if (getenv('QSYN_CONTROL_ENABLED') !== '1') {
                return '';
            }
            return self::validHash($envHash) ? $envHash : '';
        }

        $runtime = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2) . '/runtime');
        if (!str_starts_with($runtime, '/')
            || preg_match('~(?:^|/)\.\.(?:/|$)~', $runtime)
            || !is_dir($runtime)
            || is_link($runtime)) {
            return '';
        }
        // Shared PHP/Rust runtime can be group writable, but never world writable.
        $runtimeMode = @fileperms($runtime);
        if ($runtimeMode === false || ($runtimeMode & 0002) !== 0) {
            return '';
        }

        $file = rtrim($runtime, '/') . '/admin-auth.json';
        clearstatcache(true, $file);
        if (!is_file($file) || is_link($file) || !is_readable($file)) {
            return '';
        }
        $mode = @fileperms($file);
        $size = @filesize($file);
        if ($mode === false || ($mode & 0077) !== 0
            || $size === false || $size < 20 || $size > 4096) {
            return '';
        }
        $raw = @file_get_contents($file);
        if (!is_string($raw)) {
            return '';
        }
        $data = json_decode($raw, true);
        if (!is_array($data)
            || ($data['schema'] ?? null) !== 'QSYN-ADMIN/1'
            || ($data['enabled'] ?? null) !== true
            || !is_string($data['password_hash'] ?? null)) {
            return '';
        }
        $hash = $data['password_hash'];
        return self::validHash($hash) ? $hash : '';
    }

    private static function validHash(string $hash): bool
    {
        return strlen($hash) <= 255
            && (password_get_info($hash)['algoName'] ?? 'unknown') !== 'unknown';
    }

    public static function configured(): bool
    {
        return self::passwordHash() !== '';
    }

    public static function boot(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.cookie_httponly', '1');
        // Only CI loopback HTTP may use a non-Secure cookie. Real QSYN
        // deployments always require HTTPS and Secure session cookies.
        $host = (string)($_SERVER['HTTP_HOST'] ?? '');
        $testLoopback = getenv('QSYN_ALLOW_HTTP_TEST') === '1'
            && preg_match('/^(?:localhost|127\\.0\\.0\\.1)(?::[0-9]{1,5})?$/D', $host) === 1;
        ini_set('session.cookie_secure', $testLoopback ? '0' : '1');
        session_name('QSYN_ADMIN_SESSION');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/qsyn/',
            'secure' => !$testLoopback,
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
        $host = (string)($headers['HTTP_HOST'] ?? '');
        // HTTP is permitted in integration tests ONLY on a local loopback
        // host. Never permit this override on stage.digiti.in or another
        // externally reachable host, even if an env var is misconfigured.
        $localTest = getenv('QSYN_ALLOW_HTTP_TEST') === '1'
            && preg_match('/^(?:localhost|127\\.0\\.0\\.1)(?::[0-9]{1,5})?$/D', $host) === 1;
        $origin = trim((string)($headers['HTTP_ORIGIN'] ?? ''));
        if ($origin !== '' && $origin !== 'https://' . $host
            && !($localTest && $origin === 'http://' . $host)) {
            return false;
        }
        return ($headers['HTTPS'] ?? '') === 'on'
            || ($headers['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
            || $localTest;
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
        $hash = self::passwordHash();
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

<?php
declare(strict_types=1);

namespace QSYN\Routing;

use QSYN\Admin\RustAdmin;
use QSYN\Admin\RustAdminBootstrap;

/**
 * Server-enforced admin gate for every terminal page and retired alias.
 * /qsyn/ chart homepage is intentionally public and must NOT call this gate.
 * The gate does not replace account/entitlement checks on protected APIs.
 */
final class TerminalAdminGate
{
    private const LOGIN = '/qsyn/terminal/login';
    private const DEFAULT = '/qsyn/terminal/trading';

    public static function enforce(string $route, array $server, string $loginTemplatePath): void
    {
        header('Cache-Control: private, no-store, max-age=0');
        header('Pragma: no-cache');
        header('X-Frame-Options: DENY');
        header('X-Robots-Tag: noindex, nofollow');
        // Ordinary document navigation may use Sec-Fetch-Site: same-site
        // after an HTTP 303, even for our own page. A GET/HEAD cannot
        // mutate privileges. Require secure transport, but reserve the full
        // origin/fetch-metadata check for POST sign-in and setup.
        $transport = $server;
        if (in_array(($server['REQUEST_METHOD'] ?? 'GET'), ['GET', 'HEAD'], true)) {
            unset($transport['HTTP_ORIGIN'], $transport['HTTP_SEC_FETCH_SITE']);
        }
        if (!RustAdmin::originAllowed($transport)) {
            self::error(403, 'Secure same-origin terminal access required.');
        }
        RustAdmin::boot();
        if ($route === self::LOGIN) {
            self::login($server, $loginTemplatePath);
        }
        $method = $server['REQUEST_METHOD'] ?? 'GET';
        if ($method !== 'GET' && $method !== 'HEAD') {
            header('Allow: GET, HEAD');
            self::error(405, 'Method not allowed.');
        }
        if (!RustAdmin::authenticated()) {
            header('Location: ' . self::LOGIN, true, 303);
            exit;
        }
        // Authenticated request continues to the existing pretty URL router.
    }

    private static function login(array $server, string $loginTemplatePath): never
    {
        $method = $server['REQUEST_METHOD'] ?? 'GET';
        if ($method !== 'GET' && $method !== 'POST') {
            header('Allow: GET, POST');
            self::error(405, 'Method not allowed.');
        }
        if ($method === 'GET' && RustAdmin::authenticated()) {
            header('Location: ' . self::DEFAULT, true, 303);
            exit;
        }
        $message = '';
        if ($method === 'POST') {
            if (!RustAdmin::originAllowed($server)) {
                self::error(403, 'Secure same-origin terminal access required.');
            }
            $contentType = (string)($server['CONTENT_TYPE'] ?? '');
            if (!preg_match('~^application/x-www-form-urlencoded(?:\s*;|$)~i', $contentType)
                || (int)($server['CONTENT_LENGTH'] ?? 0) > 2048) {
                self::error(415, 'Invalid sign-in request.');
            }
            if (RustAdmin::configured()) {
                $token = $_POST['csrf'] ?? null;
                $password = $_POST['password'] ?? null;
                if (!is_string($token) || !RustAdmin::verifyTerminalLoginCsrf($token)) {
                    self::error(403, 'Invalid sign-in request.');
                }
                if (!is_string($password) || !RustAdmin::attempt($password)) {
                    $message = 'Invalid administrator password or sign-in temporarily locked.';
                    http_response_code(401);
                } else {
                    header('Location: ' . self::DEFAULT, true, 303);
                    exit;
                }
            } else {
                $token = $_POST['csrf'] ?? null;
                $code = $_POST['setup_code'] ?? null;
                $password = $_POST['new_password'] ?? null;
                $confirm = $_POST['confirm_password'] ?? null;
                if (!is_string($token) || !RustAdminBootstrap::validCsrf($token)) {
                    self::error(403, 'Invalid administrator setup request.');
                }
                $status = RustAdminBootstrap::status();
                if (!$status['available'] || !is_string($code) || !is_string($password)
                    || !is_string($confirm) || !hash_equals($password, $confirm)) {
                    $message = 'Administrator setup is not available or the credentials are invalid.';
                    http_response_code(403);
                } else {
                    $result = RustAdminBootstrap::complete($code, $password);
                    if (($result['ok'] ?? false) && RustAdmin::attempt($password)) {
                        header('Location: ' . self::DEFAULT, true, 303);
                        exit;
                    }
                    $message = 'Administrator setup could not be completed.';
                    http_response_code(403);
                }
            }
        }
        $configured = RustAdmin::configured();
        $setupAvailable = !$configured && RustAdminBootstrap::status()['available'];
        $csrf = $configured ? RustAdmin::terminalLoginCsrf()
            : ($setupAvailable ? RustAdminBootstrap::csrf() : '');
        // The site's global no-referrer policy causes Chromium's native
        // HTML form POST to send Origin: null. Keep cross-site referrers
        // suppressed while preserving the same-origin form Origin header.
        header('Referrer-Policy: same-origin');
        header('Content-Type: text/html; charset=utf-8');
        // Do not allow Cloudflare to insert bot-detection JavaScript into
        // the password/setup form; no extra active code should run here.
        header('Cache-Control: private, no-store, no-transform, max-age=0');
        header('Content-Security-Policy: default-src ' . "'none'"
            . '; style-src ' . "'self'"
            . '; form-action ' . "'self'"
            . '; base-uri ' . "'none'"
            . '; frame-ancestors ' . "'none'"
            . ';');
        define('QSYN_TERMINAL_LOGIN_TEMPLATE', true);
        if (!is_file($loginTemplatePath)) {
            self::error(503, 'Administrator login view unavailable.');
        }
        require $loginTemplatePath;
        exit;
    }

    private static function error(int $status, string $message): never
    {
        http_response_code($status);
        header('Content-Type: text/plain; charset=utf-8');
        echo $message;
        exit;
    }
}

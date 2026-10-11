<?php
declare(strict_types=1);

namespace QSYN\Broker;

use QSYN\Admin\RustAdmin;

/**
 * One-time administrator-only OpenAlgo APPLICATION-key and login mapping setup.
 * Does NOT provision Python, exchange access, Upstox OAuth tokens or order rights.
 * Atomic owner-only creation; never overwrites an existing registry or key.
 */
final class OpenAlgoAdminSetup
{
    /** @return array{mode:string,available:bool} */
    public static function state(): array
    {
        if (getenv('QSYN_OPENALGO_REGISTRY_FILE') || getenv('QSYN_OPENALGO_LOGIN_URLS_FILE')) {
            return ['mode' => 'external_private_configuration', 'available' => false];
        }
        try {
            $root = self::root();
            foreach (['openalgo-registry.json', 'openalgo-login-urls.json'] as $name) {
                if (file_exists($root . '/' . $name) || is_link($root . '/' . $name)) {
                    return ['mode' => 'existing_private_configuration', 'available' => false];
                }
            }
            return ['mode' => 'initial_web_setup', 'available' => true];
        } catch (\Throwable) {
            return ['mode' => 'private_storage_unavailable', 'available' => false];
        }
    }

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(array $server): array
    {
        if (getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1'
            || getenv('QSYN_CONTROL_ENABLED') === '0') {
            return [503, ['error' => 'broker_operator_setup_disabled']];
        }
        if (!RustAdmin::originAllowed($server)) {
            return [403, ['error' => 'secure_same_origin_required']];
        }
        RustAdmin::boot();
        if (($server['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
            return [405, ['error' => 'method_not_allowed']];
        }
        if (!RustAdmin::authenticated()) {
            return [401, ['error' => 'admin_login_required']];
        }
        if (!RustAdmin::verifyCsrf((string) ($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error' => 'csrf_invalid']];
        }
        if (preg_match('~^application/json(?:\s*;|$)~i',
                (string) ($server['CONTENT_TYPE'] ?? '')) !== 1) {
            return [415, ['error' => 'json_required']];
        }
        $raw = file_get_contents('php://input', false, null, 0, 4097);
        if (!is_string($raw) || strlen($raw) > 4096) {
            return [413, ['error' => 'request_too_large']];
        }
        try {
            $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!self::valid($data)) {
            return [422, ['error' => 'invalid_private_account_configuration']];
        }
        if (!self::state()['available']) {
            return [409, ['error' => 'private_account_setup_not_available']];
        }
        try {
            return [201, self::create($data)];
        } catch (\Throwable) {
            return [503, ['error' => 'private_account_setup_failed']];
        }
    }

    private static function valid(mixed $data): bool
    {
        if (!is_array($data) || array_is_list($data)
            || count($data) !== 7 || !isset($data['account_id'], $data['broker'],
                $data['rest_port'], $data['ws_port'], $data['login_url'],
                $data['application_api_key'], $data['confirmed'])) return false;
        if (!is_string($data['account_id'])
            || preg_match('/^[a-zA-Z0-9_-]{1,48}$/D', $data['account_id']) !== 1
            || !is_string($data['broker'])
            || !in_array($data['broker'], PrivateBrokerRegistry::supportedBrokers(), true)
            || !is_int($data['rest_port']) || !is_int($data['ws_port'])
            || $data['rest_port'] < 1025 || $data['rest_port'] > 65535
            || $data['ws_port'] < 1025 || $data['ws_port'] > 65535
            || $data['rest_port'] === $data['ws_port']
            || !is_string($data['login_url'])
            || !OpenAlgoBrokerConnectionsApi::isApprovedLoginUrl($data['login_url'])
            || !is_string($data['application_api_key'])
            || strlen($data['application_api_key']) < 16
            || strlen($data['application_api_key']) > 256
            || preg_match('/^[A-Za-z0-9_-]+$/D', $data['application_api_key']) !== 1
            || $data['confirmed'] !== true) return false;
        return true;
    }

    /** @return array<string,mixed> */
    private static function create(array $data): array
    {
        $root = self::root();
        $lockFile = $root . '/.openalgo-setup.lock';
        if (is_link($lockFile)) throw new \RuntimeException('invalid_setup_lock');
        $lock = self::openPrivate($lockFile, 'c');
        if ($lock === false) throw new \RuntimeException('cannot_open_setup_lock');
        try {
            self::assertPrivateFile($lockFile);
            if (!flock($lock, LOCK_EX)) throw new \RuntimeException('cannot_lock');
            $regPath = $root . '/openalgo-registry.json';
            $loginPath = $root . '/openalgo-login-urls.json';
            if (file_exists($regPath) || is_link($regPath)
                || file_exists($loginPath) || is_link($loginPath)
                || getenv('QSYN_OPENALGO_REGISTRY_FILE')
                || getenv('QSYN_OPENALGO_LOGIN_URLS_FILE')) {
                throw new \RuntimeException('private_setup_already_exists');
            }

            $keysDir = $root . '/openalgo-keys';
            if (!file_exists($keysDir)) {
                $old = umask(0077);
                try {
                    if (!@mkdir($keysDir, 0700)) {
                        throw new \RuntimeException('private_key_directory_unavailable');
                    }
                } finally { umask($old); }
            }
            if (is_link($keysDir) || !is_dir($keysDir)
                || realpath($keysDir) !== $keysDir
                || ((int)fileperms($keysDir) & 0077) !== 0
                || (function_exists('posix_geteuid') && fileowner($keysDir) !== posix_geteuid())) {
                throw new \RuntimeException('private_key_directory_insecure');
            }

            $keyPath = $keysDir . '/' . $data['account_id'] . '.key';
            if (file_exists($keyPath) || is_link($keyPath)) {
                throw new \RuntimeException('existing_application_key');
            }
            $created = [];
            try {
                self::createFile($keyPath, $data['application_api_key'] . "\n");
                $created[] = $keyPath;
                $reg = [
                    'schema' => 'QSYN-PRIVATE-OPENALGO-REGISTRY/1',
                    'accounts' => [[
                        'account_id' => $data['account_id'],
                        // Operator-only inventory, NEVER proof of UCC/user tenancy.
                        'tenant_id' => 'operator-private',
                        'owner_user_id' => 'qsyn-admin',
                        'broker' => $data['broker'],
                        'rest_port' => $data['rest_port'],
                        'ws_port' => $data['ws_port'],
                        'openalgo_apikey_file' => $keyPath,
                    ]],
                ];
                $login = [
                    'schema' => 'QSYN-OPENALGO-LOGIN-URLS/1',
                    'accounts' => [[
                        'account_id' => $data['account_id'],
                        'login_url' => $data['login_url'],
                    ]],
                ];
                self::createFile($loginPath, json_encode($login, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n");
                $created[] = $loginPath;
                self::createFile($regPath, json_encode($reg, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n");
                $created[] = $regPath;

                $verified = PrivateBrokerRegistry::loadForAdminWeb($regPath);
                $urls = OpenAlgoBrokerConnectionsApi::configuredLoginUrls($loginPath);
                if (!isset($verified[$data['account_id']], $urls[$data['account_id']])) {
                    throw new \RuntimeException('created_configuration_invalid');
                }
            } catch (\Throwable $e) {
                foreach (array_reverse($created) as $file) {
                    if (is_file($file) && !is_link($file)) @unlink($file);
                }
                throw $e;
            }
            return [
                'schema' => 'QSYN-OPENALGO-ADMIN-SETUP/1',
                'account_id' => $data['account_id'],
                'broker' => $data['broker'],
                'configuration_saved' => true,
                'session_state' => 'not_checked',
                'native_openalgo_installed' => false,
                'broker_identity_verified' => false,
                'trading_enabled_in_qsyn' => false,
            ];
        } finally {
            if (is_resource($lock)) {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
        }
    }

    private static function createFile(string $path, string $contents): void
    {
        $handle = self::openPrivate($path, 'x');
        if ($handle === false) throw new \RuntimeException('private_file_creation_denied');
        try {
            if (fwrite($handle, $contents) !== strlen($contents)
                || !fflush($handle) || !@chmod($path, 0600)) {
                throw new \RuntimeException('private_file_write_failed');
            }
            if (function_exists('fsync') && !fsync($handle)) {
                throw new \RuntimeException('private_file_sync_failed');
            }
        } catch (\Throwable $e) {
            fclose($handle);
            @unlink($path);
            throw $e;
        }
        fclose($handle);
    }

    private static function openPrivate(string $path, string $mode): mixed
    {
        $old = umask(0077);
        try { return @fopen($path, $mode); }
        finally { umask($old); }
    }

    private static function assertPrivateFile(string $path): void
    {
        clearstatcache(true, $path);
        if (is_link($path) || !is_file($path)
            || ((int)fileperms($path) & 0077) !== 0
            || (function_exists('posix_geteuid') && fileowner($path) !== posix_geteuid())) {
            throw new \RuntimeException('unsafe_setup_lock');
        }
    }

    private static function root(): string
    {
        $path = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2) . '/runtime');
        if ($path === '' || !str_starts_with($path, '/') || is_link($path)) {
            throw new \RuntimeException('private_runtime_required');
        }
        $root = realpath($path);
        if ($root === false || $root !== $path || !is_dir($root)
            || !is_writable($root)
            || preg_match('~/(?:public_html|public|webroot|www)/~i', $root)
            || ((int)fileperms($root) & 0002) !== 0
            || (function_exists('posix_geteuid') && fileowner($root) !== posix_geteuid())) {
            throw new \RuntimeException('private_runtime_insecure');
        }
        return $root;
    }
}

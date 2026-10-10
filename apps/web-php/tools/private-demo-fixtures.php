<?php
declare(strict_types=1);

/**
 * Offline mock-only fixtures for an operator-approved, separately isolated
 * development deployment. NEVER load through HTTP or package as a web route.
 *
 * Usage:
 *   php private-demo-fixtures.php seed TENANT USERNAME ROLE [--with-mock-accounts]
 *   php private-demo-fixtures.php revoke TENANT USERNAME
 *
 * Seed reads ONE password line from non-interactive STDIN. Passwords cannot
 * be passed as argv, HTTP parameters, environment variables or log values.
 * No real broker credentials, orders, authorization scopes or live feeds.
 */
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(2);
}

require_once dirname(__DIR__) . '/src/FileStore.php';
require_once dirname(__DIR__) . '/src/UserRepository.php';
require_once dirname(__DIR__) . '/src/FileUserRepository.php';
require_once dirname(__DIR__) . '/src/BrokerConnectionRepository.php';
require_once dirname(__DIR__) . '/src/FileMockBrokerConnectionRepository.php';

use QSYN\Accounts\FileMockBrokerConnectionRepository;
use QSYN\Identity\FileUserRepository;
use QSYN\Storage\FileStore;

function fixtureError(string $message): never
{
    fwrite(STDERR, "FAIL: " . $message . "\n");
    exit(1);
}

function privateFixtureStore(): FileStore
{
    if (getenv('QSYN_FIXTURE_BOOTSTRAP_ENABLED') !== '1') {
        fixtureError('Private fixture bootstrap is disabled');
    }

    // A disposable CI test is not evidence of an actual VPN/ingress ACL.
    $ci = getenv('QSYN_ENV') === 'test'
        && getenv('QSYN_ALLOW_HTTP_TEST') === '1'
        && getenv('QSYN_FIXTURE_CI') === '1'
        && getenv('CI') === 'true';
    $host = (string) (getenv('QSYN_IDENTITY_ALLOWED_HOST') ?: '');
    $private = getenv('QSYN_ENV') === 'development'
        && getenv('QSYN_PRIVATE_STAGING_CONFIRMED') === '1'
        && preg_match('/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/D', $host) === 1
        && !in_array(strtolower(explode(':', $host)[0]), [
            'stage.digiti.in', 'digiti.in', 'www.digiti.in',
        ], true);

    if (!$ci && !$private) {
        fixtureError('Approved private development context required');
    }
    $rootValue = (string) (getenv('QSYN_IDENTITY_STORAGE_DIR') ?: '');
    $publicValue = (string) (getenv('QSYN_PRIVATE_PUBLIC_DOCROOT') ?: '');
    if (!str_starts_with($rootValue, '/') || !str_starts_with($publicValue, '/')
        || str_contains($rootValue, '/..') || str_contains($publicValue, '/..')
        || is_link($rootValue) || is_link($publicValue)) {
        fixtureError('Explicit absolute private store and public document root required');
    }
    $root = realpath($rootValue);
    $public = realpath($publicValue);
    if ($root === false || $public === false || $root === '/' || $public === '/'
        || $root === $public || str_starts_with($root, $public . '/')
        || !is_dir($root) || !is_dir($public)) {
        fixtureError('Store must exist outside the web document root');
    }
    clearstatcache(true, $root);
    $mode = fileperms($root);
    if ($mode === false || ($mode & 0077) !== 0) {
        fixtureError('Identity store must be an owner-only directory');
    }

    return new FileStore($root);
}

function fixtureUser(FileStore $store, string $tenant, string $username): ?array
{
    foreach ($store->listRecords('mock_users') as $row) {
        $data = $row['data'] ?? [];
        if (($data['tenant_id'] ?? '') === $tenant && ($data['username'] ?? '') === $username) {
            return $row;
        }
    }
    return null;
}

try {
    if (count($argv) < 4 || count($argv) > 6
        || !in_array($argv[1], ['seed', 'revoke'], true)) {
        fixtureError('Usage: seed TENANT USERNAME ROLE [--with-mock-accounts] | revoke TENANT USERNAME');
    }
    $action = $argv[1];
    $tenant = $argv[2];
    $username = $argv[3];
    if (!FileUserRepository::validTenant($tenant) || !FileUserRepository::validUsername($username)) {
        fixtureError('Invalid fixture identity');
    }
    if ($action === 'revoke' && count($argv) !== 4) {
        fixtureError('Usage: revoke TENANT USERNAME');
    }
    $withAccounts = false;
    if ($action === 'seed') {
        if (!in_array($argv[4] ?? '', ['viewer', 'member', 'tenant_admin'], true)
            || count($argv) > 6 || (count($argv) === 6 && $argv[5] !== '--with-mock-accounts')) {
            fixtureError('Invalid fixture role/options');
        }
        $withAccounts = count($argv) === 6;
        if ($withAccounts && $argv[4] === 'viewer') {
            fixtureError('Viewer fixtures must not have linked accounts');
        }
    }

    $store = privateFixtureStore();
    $users = new FileUserRepository($store);
    $existing = fixtureUser($store, $tenant, $username);
    if ($action === 'revoke') {
        if ($existing === null || ($existing['data']['status'] ?? '') !== 'active') {
            fixtureError('Fixture does not exist or is already disabled');
        }
        $disabled = $users->deactivateFixture($tenant, (string) $existing['id'], (int) $existing['revision']);
        echo "PASS: test fixture revoked, user=" . $username . " tenant=" . $tenant . "\n";
        exit(0);
    }

    if ($existing !== null) {
        fixtureError('Fixture identity already exists; never overwrite existing credentials');
    }
    if (function_exists('stream_isatty') && stream_isatty(STDIN)) {
        fixtureError('Pipe password from a protected source; interactive terminal echo is not allowed');
    }
    $line = fgets(STDIN, 260);
    if (!is_string($line) || !str_ends_with($line, "\n")) {
        fixtureError('Expected one newline-terminated password on standard input');
    }
    $password = rtrim($line, "\r\n");
    if (strlen($password) < 14 || strlen($password) > 72
        || str_contains($password, "\0")) {
        fixtureError('Mock password must contain 14-72 bytes');
    }
    unset($line);
    $user = $users->createFixture($tenant, $username, $password, $argv[4]);
    unset($password);
    $count = 0;
    if ($withAccounts) {
        $accounts = new FileMockBrokerConnectionRepository($store);
        foreach ([
            ['upstox', 'mock-upstox-a', 'Upstox A (simulated)'],
            ['upstox', 'mock-upstox-b', 'Upstox B (simulated)'],
            ['dhan', 'mock-dhan-c', 'Dhan (simulated)'],
        ] as [$broker, $reference, $label]) {
            $accounts->linkMock($tenant, $user['user_id'], $broker, $reference, $label);
            $count++;
        }
    }
    echo "PASS: private test fixture seeded: tenant=" . $tenant
        . " user=" . $username . " role=" . $argv[4]
        . " mock_accounts=" . $count . "\n";
    echo "NOTE: no API enabling, HTTPS changes, real feeds or trading performed\n";
} catch (Throwable $error) {
    // Do not echo raw exceptions which might include private paths/secrets.
    fixtureError('Private fixture operation rejected; review owner-only local logs');
}

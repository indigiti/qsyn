<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/FileStore.php';
require_once dirname(__DIR__) . '/src/UserRepository.php';
require_once dirname(__DIR__) . '/src/FileUserRepository.php';
require_once dirname(__DIR__) . '/src/IdentityThrottle.php';
require_once dirname(__DIR__) . '/src/UserSession.php';

use QSYN\Identity\FileUserRepository;
use QSYN\Identity\IdentityThrottle;
use QSYN\Identity\UserSession;
use QSYN\Storage\FileStore;

$root = sys_get_temp_dir() . '/qsyn-identity-contract-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
function identityCheck(bool $condition, string $error): void {
    if (!$condition) throw new RuntimeException($error);
}
function rejected(callable $action): bool {
    try { $action(); } catch (InvalidArgumentException | RuntimeException $e) { return true; }
    return false;
}
function cleanIdentityTree(string $root): void {
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($files as $file) {
        if ($file->isDir()) rmdir($file->getPathname());
        else unlink($file->getPathname());
    }
    rmdir($root);
}

try {
    $users = new FileUserRepository(new FileStore($root));
    $a = $users->createFixture('tenant-one', 'alice', 'mock-only-alice-secret-12345', 'tenant_admin');
    $b = $users->createFixture('tenant-one', 'bob', 'mock-only-bob-password-12345', 'member');
    $c = $users->createFixture('tenant-two', 'alice', 'mock-only-tenant-two-12345', 'viewer');

    identityCheck($a['user_id'] !== $b['user_id'] && $a['user_id'] !== $c['user_id'],
        'User IDs must distinguish tenant and username');
    identityCheck(count($users->verify('tenant-one', 'alice', 'mock-only-alice-secret-12345') ?? []) > 0,
        'Valid mock password rejected');
    identityCheck($users->verify('tenant-one', 'alice', 'incorrect-password') === null,
        'Invalid password accepted');
    identityCheck($users->verify('tenant-two', 'alice', 'mock-only-alice-secret-12345') === null,
        'Tenant-crossing credential accepted');
    identityCheck($users->findById('tenant-two', $a['user_id']) === null,
        'Foreign tenant lookup leaked user');
    identityCheck($users->findById('tenant-one', $a['user_id'])['username'] === 'alice',
        'Owner lookup incorrect');
    foreach ([$a, $b, $c] as $user) {
        identityCheck(!array_key_exists('password_hash', $user), 'Hash leaked from fixture API');
    }

    identityCheck(UserSession::authorized($a, 'tenant-one', 'tenant_admin'),
        'Admin role should authorize local tenant');
    identityCheck(UserSession::authorized($a, 'tenant-one', 'member'),
        'Admin must inherit member permissions');
    identityCheck(!UserSession::authorized($b, 'tenant-one', 'tenant_admin'),
        'Member must not escalate');
    identityCheck(!UserSession::authorized($a, 'tenant-two', 'viewer'),
        'Tenant admin must not cross tenants');
    identityCheck(!FileUserRepository::hasRole(['role' => 'invalid', 'status' => 'active'], 'viewer'),
        'Unknown role accepted');

    identityCheck(rejected(fn () => $users->createFixture(
        'tenant-one', 'alice', 'mock-only-alice-secret-12345', 'tenant_admin')),
        'Duplicate identity must reject');
    identityCheck(rejected(fn () => $users->createFixture(
        '../path', 'alice', 'mock-only-alice-secret-12345', 'member')),
        'Path traversal tenant accepted');
    identityCheck(rejected(fn () => $users->createFixture(
        'tenant-one', 'invalid-name!', 'mock-only-alice-secret-12345', 'member')),
        'Invalid username accepted');
    identityCheck(rejected(fn () => $users->createFixture(
        'tenant-one', 'dave', 'short', 'member')),
        'Weak fixture password accepted');
    identityCheck(rejected(fn () => $users->createFixture(
        'tenant-one', 'dave', 'mock-only-password-123456', 'owner')),
        'Unrecognized role accepted');

    identityCheck(rejected(fn () => $users->deactivateFixture('tenant-two', $a['user_id'], 1)),
        'Cross-tenant deactivation accepted');
    identityCheck(rejected(fn () => $users->deactivateFixture('tenant-one', $a['user_id'], 0)),
        'Incorrect revision accepted');
    $disabled = $users->deactivateFixture('tenant-one', $a['user_id'], 1);
    identityCheck($disabled['status'] === 'disabled' && $disabled['revision'] === 2,
        'Deactivation must update record revision');
    identityCheck($users->findById('tenant-one', $a['user_id']) === null,
        'Disabled identity can still be read as active');
    identityCheck($users->verify('tenant-one', 'alice', 'mock-only-alice-secret-12345') === null,
        'Disabled identity still signs in');
    identityCheck($users->findById('tenant-one', $b['user_id']) !== null,
        'Disabling Alice must not disable Bob');

    $path = $root . '/mock_users/' . $a['user_id'] . '.json';
    identityCheck((fileperms($path) & 0777) === 0600,
        'Mock identity record not restricted to owner');
    $raw = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    identityCheck(($raw['data']['password_hash'] ?? '') !== 'mock-only-alice-secret-12345'
        && password_verify('mock-only-alice-secret-12345', $raw['data']['password_hash']),
        'Private password must be hashed and verifiable');

    $limiter = new IdentityThrottle($root);
    for ($i = 0; $i < 5; $i++) {
        identityCheck($limiter->reserve('127.0.0.1', 'tenant-one', 'alice'),
            'Allowed login attempt rejected');
    }
    identityCheck(!$limiter->reserve('127.0.0.1', 'tenant-one', 'alice'),
        'Sixth attempt must be rate-limited');
    identityCheck($limiter->reserve('127.0.0.2', 'tenant-one', 'alice'),
        'Source identity limit unexpectedly global');
    identityCheck($limiter->reserve('127.0.0.1', 'tenant-one', 'bob'),
        'Unrelated user must not inherit throttled key');

    putenv('QSYN_ENV=test');
    putenv('QSYN_ALLOW_HTTP_TEST=1');
    $loopback = ['HTTP_HOST' => '127.0.0.1:18888', 'HTTP_ORIGIN' => 'http://127.0.0.1:18888',
        'REMOTE_ADDR' => '127.0.0.1', 'SERVER_ADDR' => '127.0.0.1'];
    identityCheck(UserSession::originAllowed($loopback), 'Test-only same-origin rejected');
    identityCheck(!UserSession::loopbackTest(array_replace($loopback,
        ['REMOTE_ADDR' => '198.51.100.10'])), 'Host-spoofed remote client bypassed HTTP test gate');
    identityCheck(!UserSession::loopbackTest(array_replace($loopback,
        ['SERVER_ADDR' => '198.51.100.10'])), 'Public listener bypassed HTTP test gate');
    identityCheck(!UserSession::originAllowed($loopback + ['HTTP_SEC_FETCH_SITE' => 'cross-site']),
        'Cross-site fetch marker accepted');
    identityCheck(!UserSession::originAllowed(array_replace($loopback,
        ['HTTP_ORIGIN' => 'http://evil.example'])), 'Cross-origin POST accepted');
    identityCheck(!UserSession::originAllowed(['HTTP_HOST' => 'stage.digiti.in',
        'HTTP_ORIGIN' => 'http://stage.digiti.in']), 'HTTP allowed on non-loopback host');
    putenv('QSYN_ALLOW_HTTP_TEST');
    putenv('QSYN_ENV');

    echo "PASS: identity contracts, roles, tenant isolation, password hashing and throttling\n";
} finally {
    cleanIdentityTree($root);
}

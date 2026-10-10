<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/FileStore.php';
require_once dirname(__DIR__) . '/src/UserRepository.php';
require_once dirname(__DIR__) . '/src/FileUserRepository.php';
require_once dirname(__DIR__) . '/src/UserSession.php';
require_once dirname(__DIR__) . '/src/BrokerConnectionRepository.php';
require_once dirname(__DIR__) . '/src/FileMockBrokerConnectionRepository.php';
require_once dirname(__DIR__) . '/src/FileMockWorkspaceRepository.php';
require_once dirname(__DIR__) . '/src/FileMockAuditLog.php';

use QSYN\Storage\FileStore;
use QSYN\Identity\FileUserRepository;
use QSYN\Identity\UserSession;
use QSYN\Accounts\FileMockBrokerConnectionRepository;
use QSYN\Accounts\FileMockWorkspaceRepository;
use QSYN\Audit\FileMockAuditLog;

function checkWorkspace(bool $ok, string $description): void
{
    if (!$ok) throw new RuntimeException($description);
}
function rejectWorkspace(callable $work): bool
{
    try { $work(); } catch (InvalidArgumentException | RuntimeException $error) { return true; }
    return false;
}
$root = sys_get_temp_dir() . '/qsyn-workspace-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
try {
    $store = new FileStore($root);
    $users = new FileUserRepository($store);
    $a = $users->createFixture('tenant-one', 'alice', 'test-only-alice-secret-12345', 'member');
    $b = $users->createFixture('tenant-one', 'bob', 'test-only-bob-secret-12345', 'viewer');
    $c = $users->createFixture('tenant-two', 'alice', 'test-only-other-secret-12345', 'member');
    $accounts = new FileMockBrokerConnectionRepository($store);
    $accountA = $accounts->linkMock('tenant-one', $a['user_id'], 'upstox', 'mock-a', 'Upstox A');
    $accountB = $accounts->linkMock('tenant-one', $a['user_id'], 'upstox', 'mock-b', 'Upstox B');
    $other = $accounts->linkMock('tenant-two', $c['user_id'], 'upstox', 'mock-a', 'Other tenant');
    $workspace = new FileMockWorkspaceRepository($store, $accounts);

    $empty = $workspace->getForOwner('tenant-one', $a['user_id'], $accountA['account_id']);
    checkWorkspace($empty === [
        'account_id' => $accountA['account_id'],
        'revision' => 0,
        'settings' => ['theme' => 'dark', 'visible_bars' => 100, 'layout' => 'split'],
    ], 'Uninitialized chart view should have canonical defaults');
    $settings = ['theme' => 'light', 'visible_bars' => 60, 'layout' => 'focus'];
    $saved = $workspace->saveForOwner(
        'tenant-one', $a['user_id'], $accountA['account_id'], $settings, 0
    );
    checkWorkspace($saved['revision'] === 1 && $saved['settings'] === $settings,
        'Saved workspace settings or revision incorrect');
    // Fresh repository simulates PHP-FPM request/process restart.
    $newRepository = new FileMockWorkspaceRepository(new FileStore($root), $accounts);
    checkWorkspace($newRepository->getForOwner(
        'tenant-one', $a['user_id'], $accountA['account_id']) === $saved,
        'Workspace settings failed to persist across process-independent reload');
    checkWorkspace($newRepository->getForOwner(
        'tenant-one', $a['user_id'], $accountB['account_id'])['revision'] === 0,
        'Mock Upstox B inherited Upstox A workspace');
    checkWorkspace($newRepository->getForOwner(
        'tenant-two', $c['user_id'], $other['account_id'])['revision'] === 0,
        'Another tenant inherited workspace');
    checkWorkspace(rejectWorkspace(fn() => $workspace->getForOwner(
        'tenant-one', $b['user_id'], $accountA['account_id'])),
        'Cross-user workspace read succeeded');
    checkWorkspace(rejectWorkspace(fn() => $workspace->saveForOwner(
        'tenant-two', $c['user_id'], $accountA['account_id'], $settings, 0)),
        'Cross-tenant workspace write succeeded');
    checkWorkspace(rejectWorkspace(fn() => $workspace->saveForOwner(
        'tenant-one', $a['user_id'], $accountA['account_id'], $settings, 0)),
        'Stale revision saved over newer workspace');
    foreach ([
        ['theme' => 'not-theme', 'visible_bars' => 100, 'layout' => 'split'],
        ['theme' => 'dark', 'visible_bars' => 250, 'layout' => 'split'],
        ['theme' => 'dark', 'visible_bars' => 100, 'layout' => '<script>'],
        ['theme' => 'dark', 'visible_bars' => 100, 'layout' => 'split', 'secret' => 'x'],
    ] as $invalid) {
        checkWorkspace(rejectWorkspace(fn() => $workspace->saveForOwner(
            'tenant-one', $a['user_id'], $accountA['account_id'], $invalid, 1
        )), 'Invalid/unsanctioned workspace property accepted');
    }
    $accounts->disconnectMock('tenant-one', $a['user_id'], $accountA['account_id'], 1);
    checkWorkspace(rejectWorkspace(fn() => $workspace->getForOwner(
        'tenant-one', $a['user_id'], $accountA['account_id'])),
        'Disconnected mock account workspace still readable');

    $audit = new FileMockAuditLog($store);
    $intent = $audit->record('tenant-one', $a['user_id'], 'workspace.save', 'intent', $accountB['account_id']);
    $audit->record('tenant-one', $a['user_id'], 'workspace.save', 'completed', $accountB['account_id'], $intent['correlation_id']);
    $audit->record('tenant-two', $c['user_id'], 'auth.login', 'completed');
    $logs = $store->listRecords('mock_audit_events');
    checkWorkspace(count($logs) === 3, 'Durable audit events are missing');
    $matching = array_values(array_filter($logs, static fn($row) =>
        ($row['data']['correlation_id'] ?? '') === $intent['correlation_id']));
    checkWorkspace(count($matching) === 2, 'Audit correlation not durable');
    foreach ($logs as $event) {
        checkWorkspace($event['revision'] === 1
            && isset($event['data']['actor_user_id'], $event['data']['at']), 'Bad audit payload');
        $raw = (string) file_get_contents($root . '/mock_audit_events/' . $event['id'] . '.json');
        checkWorkspace((fileperms($root . '/mock_audit_events/' . $event['id'] . '.json') & 0777) === 0600,
            'Mock audit event must be a private 0600 record');
        foreach (['password', 'token', 'api_key', '127.0.0.1', 'display_label'] as $forbidden) {
            checkWorkspace(!str_contains($raw, $forbidden), 'Audit event contains forbidden sensitive details');
        }
    }
    checkWorkspace(rejectWorkspace(fn() => $audit->record(
        'tenant-one', $a['user_id'], 'order.place', 'completed')),
        'Audit writer allowed trading events');

    // A stolen session claim must not retain permission beyond revocation,
    // even when the backing PHP session record remains intact.
    putenv('QSYN_ENV=test');
    putenv('QSYN_ALLOW_HTTP_TEST=1');
    mkdir($root . '/php-sessions', 0700);
    session_save_path($root . '/php-sessions');
    checkWorkspace(UserSession::boot(['HTTP_HOST' => '127.0.0.1:18000',
        'REMOTE_ADDR' => '127.0.0.1', 'SERVER_ADDR' => '127.0.0.1']),
        'Unable to create independent user session');
    UserSession::login($b);
    checkWorkspace(UserSession::principal($users)['username'] === 'bob',
        'Authenticated mock user not resolved');
    $_SESSION['identity_user']['last_seen'] = time() - 1201;
    checkWorkspace(UserSession::principal($users) === null,
        'Expired 20-minute inactivity session remained authenticated');
    UserSession::login($b);
    $_SESSION['identity_user']['issued_at'] = time() - 43201;
    checkWorkspace(UserSession::principal($users) === null,
        'Expired 12-hour absolute session remained authenticated');
    UserSession::login($b);
    $users->deactivateFixture('tenant-one', $b['user_id'], $b['revision']);
    checkWorkspace(UserSession::principal($users) === null,
        'Disabled test user retained authenticated session');
    session_write_close();
    putenv('QSYN_ENV');
    putenv('QSYN_ALLOW_HTTP_TEST');
    echo "PASS: account-scoped workspace persistence, CAS, audit privacy, session expiry/revocation\n";
} finally {
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    $entries = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($entries as $file) {
        if ($file->isDir()) rmdir($file->getPathname());
        else unlink($file->getPathname());
    }
    rmdir($root);
}

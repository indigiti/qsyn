<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/FileStore.php';
require_once dirname(__DIR__) . '/src/BrokerConnectionRepository.php';
require_once dirname(__DIR__) . '/src/FileMockBrokerConnectionRepository.php';
require_once dirname(__DIR__) . '/src/FileMockAccountSelection.php';

use QSYN\Accounts\FileMockBrokerConnectionRepository;
use QSYN\Accounts\FileMockAccountSelection;
use QSYN\Storage\FileStore;

$root = sys_get_temp_dir() . '/qsyn-mock-accounts-' . bin2hex(random_bytes(8));
$store = new FileStore($root);
$accounts = new FileMockBrokerConnectionRepository($store);
$selections = new FileMockAccountSelection($store, $accounts);

function assertAccount(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function expectRejected(callable $run, string $message): void
{
    try {
        $run();
    } catch (InvalidArgumentException | RuntimeException $error) {
        return;
    }
    throw new RuntimeException($message);
}

try {
    $a = $accounts->linkMock('tenant-one', 'user-a', 'upstox', 'mock-upstox-a', 'Upstox A');
    $b = $accounts->linkMock('tenant-one', 'user-a', 'upstox', 'mock-upstox-b', 'Upstox B');
    $c = $accounts->linkMock('tenant-one', 'user-a', 'dhan', 'mock-dhan-c', 'Dhan mock');
    $other = $accounts->linkMock('tenant-one', 'user-b', 'upstox', 'mock-upstox-a', 'Other owner');
    $anotherTenant = $accounts->linkMock('tenant-two', 'user-a', 'upstox', 'mock-upstox-a', 'Other tenant');

    assertAccount(count($accounts->listForOwner('tenant-one', 'user-a')) === 3,
        'Owner must have exactly three mock accounts');
    assertAccount($a['account_id'] !== $b['account_id']
        && $a['account_id'] !== $other['account_id']
        && $a['account_id'] !== $anotherTenant['account_id'],
        'Mock account IDs must isolate broker reference, owner and tenant');
    assertAccount($a['revision'] === 1 && $b['broker_code'] === 'upstox'
        && $c['broker_code'] === 'dhan', 'Two Upstox accounts and another broker');
    assertAccount(count($accounts->listForOwner('tenant-one', 'user-b')) === 1
        && count($accounts->listForOwner('tenant-two', 'user-a')) === 1,
        'Different owners and tenants must remain isolated');
    assertAccount($accounts->getForOwner('tenant-one', 'user-b', $a['account_id']) === null,
        'Cross-owner lookup leaked mock account');
    assertAccount($accounts->getForOwner('tenant-two', 'user-a', $a['account_id']) === null,
        'Cross-tenant lookup leaked mock account');
    assertAccount($accounts->getForOwner('tenant-one', 'user-a', $a['account_id'])['display_label'] === 'Upstox A',
        'Owner lookup failed');
    assertAccount($accounts->getForOwner('tenant-one', 'user-a',
        'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee') === null, 'Missing account should not exist');

    foreach ([$a, $b, $c, $other, $anotherTenant] as $account) {
        assertAccount($account['execution_allowed'] === false,
            'Mock account unexpectedly permits execution');
        assertAccount($account['feed_entitlements'] === ['simulated'],
            'Mock account unexpectedly grants a real feed entitlement');
        assertAccount($account['authorized_scopes'] === ['demo:quotes'],
            'Mock account unexpectedly grants real broker scopes');
        assertAccount(str_starts_with($account['broker_account_reference'], 'mock-'),
            'Non-mock broker reference persisted');
        assertAccount(!isset($account['access_token']) && !isset($account['api_key']),
            'Mock adapter must never persist credential fields');
    }

    expectRejected(fn () => $accounts->linkMock('tenant-one', 'user-a',
        'upstox', 'mock-upstox-a', 'duplicate'), 'Duplicate mock account must fail');
    expectRejected(fn () => $accounts->linkMock('tenant-one', 'user-a',
        'upstox', 'actual-external-id', 'unsafe'), 'Real-looking broker identifier accepted');
    expectRejected(fn () => $accounts->linkMock('tenant-one', 'user-a',
        'unknown', 'mock-other', 'unsupported'), 'Unsupported broker accepted');
    expectRejected(fn () => $accounts->linkMock('../tenant', 'user-a',
        'upstox', 'mock-new', 'unsafe'), 'Unsafe tenant identifier accepted');
    expectRejected(fn () => $accounts->disconnectMock('tenant-one', 'user-b',
        $a['account_id'], 1), 'Cross-owner disconnect unexpectedly succeeded');
    expectRejected(fn () => $accounts->disconnectMock('tenant-two', 'user-a',
        $a['account_id'], 1), 'Cross-tenant disconnect unexpectedly succeeded');

    assertAccount($selections->current('tenant-one', 'user-a') ===
        ['account_id' => null, 'revision' => 0], 'Default selection must start empty');
    $selectedA = $selections->choose('tenant-one', 'user-a', $a['account_id'], 0);
    assertAccount($selectedA['account_id'] === $a['account_id'] && $selectedA['revision'] === 1,
        'Selecting first Upstox account must publish single CAS record');
    expectRejected(fn () => $selections->choose('tenant-one', 'user-a',
        $b['account_id'], 0), 'Stale selection update accepted');
    expectRejected(fn () => $selections->choose('tenant-one', 'user-b',
        $a['account_id'], 0), 'Cross-owner source selection accepted');
    expectRejected(fn () => $selections->choose('tenant-two', 'user-a',
        $a['account_id'], 0), 'Cross-tenant source selection accepted');
    assertAccount($selections->current('tenant-one', 'user-b')['account_id'] === null,
        'Owner B inherited owner A chart selection');

    $disconnected = $accounts->disconnectMock('tenant-one', 'user-a', $a['account_id'], 1);
    assertAccount($disconnected['revision'] === 2 && $disconnected['auth_status'] === 'disconnected',
        'Mock account disconnect failed to persist');
    assertAccount($disconnected['execution_allowed'] === false
        && $disconnected['is_default_chart_source'] === false,
        'Disconnected mock account must not be executable or default');
    expectRejected(fn () => $accounts->disconnectMock('tenant-one', 'user-a',
        $a['account_id'], 1), 'Stale revision disconnect unexpectedly succeeded');
    assertAccount(count($accounts->listForOwner('tenant-one', 'user-a')) === 3,
        'Disconnect must preserve account history and all other accounts');
    assertAccount($accounts->getForOwner('tenant-one', 'user-a',
        $b['account_id'])['auth_status'] === 'mock_connected',
        'Disconnecting Upstox A must not disconnect Upstox B');

    assertAccount($selections->current('tenant-one', 'user-a') ===
        ['account_id' => null, 'revision' => 1],
        'Disconnected account must not remain selected');
    expectRejected(fn () => $selections->choose('tenant-one', 'user-a',
        $a['account_id'], 1), 'Disconnected account reselected');
    $selectedB = $selections->choose('tenant-one', 'user-a', $b['account_id'], 1);
    assertAccount($selectedB['revision'] === 2 &&
        $selections->current('tenant-one', 'user-a')['account_id'] === $b['account_id'],
        'Replacement chart selection not effective');
    $renamed = $accounts->renameMock('tenant-one', 'user-a',
        $b['account_id'], 'Upstox B renamed', 1);
    assertAccount($renamed['revision'] === 2 && $renamed['display_label'] === 'Upstox B renamed',
        'Rename must use revision CAS');
    expectRejected(fn () => $accounts->renameMock('tenant-one', 'user-a',
        $b['account_id'], 'stale label', 1), 'Stale rename unexpectedly accepted');
    expectRejected(fn () => $accounts->renameMock('tenant-one', 'user-b',
        $b['account_id'], 'foreign label', 2), 'Cross-owner rename succeeded');
    expectRejected(fn () => $accounts->renameMock('tenant-two', 'user-a',
        $b['account_id'], 'foreign label', 2), 'Cross-tenant rename succeeded');

    $stored = $store->listRecords('mock_broker_accounts');
    assertAccount(count($stored) === 5, 'Private collection did not store all five records');
    assertAccount((fileperms($root . '/mock_broker_accounts/' . $a['account_id'] . '.json') & 0777) === 0600,
        'Private account records must use restrictive permissions');

    echo "PASS: Phase 1 multi-broker mock account ownership and revision contracts\n";
} finally {
    if (is_dir($root)) {
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
}

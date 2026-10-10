<?php
declare(strict_types=1);

namespace QSYN\Accounts;

use InvalidArgumentException;
use QSYN\Storage\FileStore;
use RuntimeException;

/**
 * One owner-scoped, revisioned mock chart layout per linked account.
 * Not a production workspace store or a high-frequency market-data cache.
 */
final class FileMockWorkspaceRepository
{
    private const COLLECTION = 'mock_chart_workspaces';
    private const DEFAULTS = ['theme' => 'dark', 'visible_bars' => 100, 'layout' => 'split'];

    public function __construct(
        private FileStore $store,
        private BrokerConnectionRepository $accounts
    ) {}

    private static function recordId(string $tenant, string $owner, string $accountId): string
    {
        return 'w_' . substr(hash('sha256', implode("\0", [$tenant, $owner, $accountId])), 0, 40);
    }

    private function assertOwner(string $tenant, string $owner, string $accountId): void
    {
        $account = $this->accounts->getForOwner($tenant, $owner, $accountId);
        if ($account === null || ($account['auth_status'] ?? null) !== 'mock_connected') {
            throw new RuntimeException('Mock account not found');
        }
    }

    public static function settings(array $input): array
    {
        if (array_keys($input) !== ['theme', 'visible_bars', 'layout']
            || !in_array($input['theme'], ['dark', 'light'], true)
            || !in_array($input['visible_bars'], [60, 100, 120], true)
            || !in_array($input['layout'], ['split', 'focus'], true)) {
            throw new InvalidArgumentException('Invalid chart workspace settings');
        }
        return $input;
    }

    public function getForOwner(string $tenant, string $owner, string $accountId): array
    {
        $this->assertOwner($tenant, $owner, $accountId);
        $record = $this->store->get(self::COLLECTION, self::recordId($tenant, $owner, $accountId));
        if ($record === null) {
            return ['account_id' => $accountId, 'revision' => 0, 'settings' => self::DEFAULTS];
        }
        $data = $record['data'] ?? null;
        if (!is_array($data) || ($data['tenant_id'] ?? null) !== $tenant
            || ($data['owner_user_id'] ?? null) !== $owner
            || ($data['account_id'] ?? null) !== $accountId
            || !is_array($data['settings'] ?? null)) {
            throw new RuntimeException('Corrupt workspace record');
        }
        return [
            'account_id' => $accountId,
            'revision' => (int) $record['revision'],
            'settings' => self::settings($data['settings']),
        ];
    }

    public function saveForOwner(
        string $tenant,
        string $owner,
        string $accountId,
        array $settings,
        int $expectedRevision
    ): array {
        if ($expectedRevision < 0) {
            throw new InvalidArgumentException('Invalid workspace revision');
        }
        $this->assertOwner($tenant, $owner, $accountId);
        $settings = self::settings($settings);
        $now = gmdate('c');
        $saved = $this->store->put(
            self::COLLECTION,
            self::recordId($tenant, $owner, $accountId),
            [
                'tenant_id' => $tenant,
                'owner_user_id' => $owner,
                'account_id' => $accountId,
                'settings' => $settings,
                'updated_at' => $now,
            ],
            $expectedRevision
        );
        return [
            'account_id' => $accountId,
            'revision' => (int) $saved['revision'],
            'settings' => $settings,
        ];
    }
}

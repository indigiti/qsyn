<?php
declare(strict_types=1);

namespace QSYN\Accounts;

use InvalidArgumentException;
use QSYN\Storage\FileStore;
use RuntimeException;

/**
 * One revisioned chart-source selection per mock user. Stored separately
 * from broker account records to avoid a non-atomic multi-file "default"
 * update and prevent two concurrently selected accounts.
 */
final class FileMockAccountSelection
{
    private const COLLECTION = 'mock_chart_selections';

    public function __construct(
        private FileStore $store,
        private BrokerConnectionRepository $accounts
    ) {}

    private static function recordId(string $tenant, string $owner): string
    {
        return 's_' . substr(hash('sha256', $tenant . "\0" . $owner), 0, 40);
    }

    public function current(string $tenant, string $owner): array
    {
        $record = $this->store->get(self::COLLECTION, self::recordId($tenant, $owner));
        if ($record === null) {
            return ['account_id' => null, 'revision' => 0];
        }
        $data = $record['data'] ?? [];
        if (!is_array($data) || ($data['tenant_id'] ?? null) !== $tenant
            || ($data['owner_user_id'] ?? null) !== $owner) {
            throw new RuntimeException('Corrupt selection record');
        }
        $id = (string) ($data['account_id'] ?? '');
        $account = $id === '' ? null : $this->accounts->getForOwner($tenant, $owner, $id);
        return [
            // A disconnected source never remains an effective chart source,
            // even if the selection record has not yet been replaced.
            'account_id' => $account !== null && ($account['auth_status'] ?? null) === 'mock_connected'
                ? $id : null,
            'revision' => (int) $record['revision'],
        ];
    }

    public function choose(string $tenant, string $owner, string $accountId, int $expectedRevision): array
    {
        if ($expectedRevision < 0) {
            throw new InvalidArgumentException('Invalid selection revision');
        }
        $account = $this->accounts->getForOwner($tenant, $owner, $accountId);
        if ($account === null) {
            throw new RuntimeException('Mock account not found');
        }
        if (($account['auth_status'] ?? null) !== 'mock_connected') {
            throw new RuntimeException('Mock account disconnected');
        }
        $saved = $this->store->put(
            self::COLLECTION,
            self::recordId($tenant, $owner),
            [
                'tenant_id' => $tenant,
                'owner_user_id' => $owner,
                'account_id' => $accountId,
                'updated_at' => gmdate('c'),
            ],
            $expectedRevision
        );
        return ['account_id' => $accountId, 'revision' => $saved['revision']];
    }
}

<?php
declare(strict_types=1);

namespace QSYN\Accounts;

use InvalidArgumentException;
use QSYN\Storage\FileStore;
use RuntimeException;

/**
 * Phase 1 development adapter: fake linked broker account metadata ONLY.
 *
 * Never persist Upstox tokens, live broker account references, order details
 * or customer credentials here. Only authenticated, opted-in mock account
 * controllers may call this adapter; callers must supply a trusted principal.
 */
final class FileMockBrokerConnectionRepository implements BrokerConnectionRepository
{
    private const COLLECTION = 'mock_broker_accounts';
    private const BROKERS = ['upstox', 'zerodha', 'dhan'];
    // Fixed UUIDv5 namespace, unique to QSYN's simulated linked accounts.
    private const NAMESPACE_HEX = 'f27e549b132a4e33a471018d39a11c3a';

    public function __construct(private FileStore $store) {}

    private static function assertIdentity(string $identity): void
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{2,64}$/D', $identity)) {
            throw new InvalidArgumentException('Invalid tenant or user identifier');
        }
    }

    private static function assertAccountId(string $accountId): void
    {
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $accountId)) {
            throw new InvalidArgumentException('Invalid mock account identifier');
        }
    }

    private static function stableMockId(
        string $tenantId,
        string $ownerUserId,
        string $brokerCode,
        string $mockReference
    ): string {
        // A deterministic UUIDv5 means concurrent attempts to register the
        // same owner/broker/reference contend on one FileStore revision lock,
        // rather than creating duplicate records under random IDs.
        $namespace = hex2bin(self::NAMESPACE_HEX);
        $name = implode("\0", [$tenantId, $ownerUserId, $brokerCode, $mockReference]);
        $hash = hash('sha1', $namespace . $name, true);
        $hash[6] = chr((ord($hash[6]) & 0x0f) | 0x50);
        $hash[8] = chr((ord($hash[8]) & 0x3f) | 0x80);
        $hex = bin2hex(substr($hash, 0, 16));
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-'
            . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-'
            . substr($hex, 20, 12);
    }

    private static function present(array $record): array
    {
        return [
            'account_id' => (string) $record['id'],
            'revision' => (int) $record['revision'],
        ] + $record['data'];
    }

    public function linkMock(
        string $tenantId,
        string $ownerUserId,
        string $brokerCode,
        string $mockReference,
        string $displayLabel
    ): array {
        self::assertIdentity($tenantId);
        self::assertIdentity($ownerUserId);
        if (!in_array($brokerCode, self::BROKERS, true)) {
            throw new InvalidArgumentException('Unsupported mock broker');
        }
        // Only explicitly fabricated references are accepted; never accept
        // an actual broker account number, authorization code or token.
        if (!preg_match('/^mock-[a-zA-Z0-9_-]{1,32}$/D', $mockReference)) {
            throw new InvalidArgumentException('Mock reference required');
        }
        $displayLabel = trim($displayLabel);
        if ($displayLabel === '' || strlen($displayLabel) > 60) {
            throw new InvalidArgumentException('Invalid account label');
        }

        $accountId = self::stableMockId(
            $tenantId, $ownerUserId, $brokerCode, $mockReference
        );
        $now = gmdate('c');
        try {
            $record = $this->store->put(self::COLLECTION, $accountId, [
                'tenant_id' => $tenantId,
                'owner_user_id' => $ownerUserId,
                'broker_code' => $brokerCode,
                'broker_account_reference' => $mockReference,
                'display_label' => $displayLabel,
                'integration_instance_id' => 'simulated-' . $accountId,
                'auth_status' => 'mock_connected',
                'authorized_scopes' => ['demo:quotes'],
                'feed_entitlements' => ['simulated'],
                'last_healthcheck_at' => null,
                'is_default_chart_source' => false,
                'execution_allowed' => false,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        } catch (RuntimeException $error) {
            if ($error->getMessage() === 'Revision conflict') {
                throw new RuntimeException('Mock broker account already linked', 0, $error);
            }
            throw $error;
        }
        return self::present($record);
    }

    public function listForOwner(string $tenantId, string $ownerUserId): array
    {
        self::assertIdentity($tenantId);
        self::assertIdentity($ownerUserId);
        $results = [];
        foreach ($this->store->listRecords(self::COLLECTION) as $record) {
            $data = $record['data'] ?? null;
            if (!is_array($data)) {
                throw new RuntimeException('Invalid account record');
            }
            if (($data['tenant_id'] ?? null) === $tenantId
                && ($data['owner_user_id'] ?? null) === $ownerUserId) {
                $results[] = self::present($record);
            }
        }
        usort($results, static fn (array $a, array $b): int =>
            strcmp($a['account_id'], $b['account_id']));
        return $results;
    }

    public function getForOwner(
        string $tenantId,
        string $ownerUserId,
        string $accountId
    ): ?array {
        self::assertIdentity($tenantId);
        self::assertIdentity($ownerUserId);
        self::assertAccountId($accountId);
        $record = $this->store->get(self::COLLECTION, $accountId);
        if ($record === null) {
            return null;
        }
        $data = $record['data'] ?? null;
        if (!is_array($data)
            || ($data['tenant_id'] ?? null) !== $tenantId
            || ($data['owner_user_id'] ?? null) !== $ownerUserId) {
            return null;
        }
        return self::present($record);
    }

    public function renameMock(
        string $tenantId,
        string $ownerUserId,
        string $accountId,
        string $displayLabel,
        int $expectedRevision
    ): array {
        $account = $this->getForOwner($tenantId, $ownerUserId, $accountId);
        if ($account === null) {
            throw new RuntimeException('Mock account not found');
        }
        $label = trim($displayLabel);
        if ($label === '' || strlen($label) > 60 || $expectedRevision < 1) {
            throw new InvalidArgumentException('Invalid account rename');
        }
        if (($account['auth_status'] ?? '') !== 'mock_connected') {
            throw new RuntimeException('Mock account disconnected');
        }
        $data = $this->store->get(self::COLLECTION, $accountId)['data'];
        $data['display_label'] = $label;
        $data['updated_at'] = gmdate('c');
        // Ownership was checked above; revision CAS prevents stale rename or
        // accidental resurrection after a concurrent disconnect.
        return self::present($this->store->put(
            self::COLLECTION, $accountId, $data, $expectedRevision
        ));
    }

    public function disconnectMock(
        string $tenantId,
        string $ownerUserId,
        string $accountId,
        int $expectedRevision
    ): array {
        $account = $this->getForOwner($tenantId, $ownerUserId, $accountId);
        if ($account === null) {
            // No cross-tenant existence oracle: foreign and missing accounts
            // have the same error, and neither may be modified.
            throw new RuntimeException('Mock account not found');
        }
        if ($expectedRevision < 1) {
            throw new InvalidArgumentException('Expected revision required');
        }
        $current = $this->store->get(self::COLLECTION, $accountId);
        if ($current === null) {
            throw new RuntimeException('Mock account not found');
        }
        $data = $current['data'];
        $data['auth_status'] = 'disconnected';
        $data['is_default_chart_source'] = false;
        $data['execution_allowed'] = false;
        $data['updated_at'] = gmdate('c');
        // Never use $current['revision'] here: the caller must provide its
        // previous revision so stale concurrent updates cannot be accepted.
        $saved = $this->store->put(
            self::COLLECTION, $accountId, $data, $expectedRevision
        );
        return self::present($saved);
    }
}

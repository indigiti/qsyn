<?php
declare(strict_types=1);

namespace QSYN\Accounts;

/**
 * Phase 1 account metadata contract. Ownership comes from a trusted caller
 * (eventually QSYN authentication), never from an anonymous HTTP parameter.
 *
 * Mock identities only in this phase; credentials and real broker access are
 * outside this interface until the production security gates are complete.
 */
interface BrokerConnectionRepository
{
    public function linkMock(
        string $tenantId,
        string $ownerUserId,
        string $brokerCode,
        string $mockReference,
        string $displayLabel
    ): array;

    /** @return list<array<string, mixed>> */
    public function listForOwner(string $tenantId, string $ownerUserId): array;

    public function getForOwner(
        string $tenantId,
        string $ownerUserId,
        string $accountId
    ): ?array;

    public function disconnectMock(
        string $tenantId,
        string $ownerUserId,
        string $accountId,
        int $expectedRevision
    ): array;
}

<?php
declare(strict_types=1);

namespace QSYN\Identity;

/**
 * Private, development-only identity contract; no public registration or
 * production credentials. Application controllers must derive the caller's
 * tenant and user from a validated session, never a request parameter.
 */
interface UserRepository
{
    public function createFixture(string $tenantId, string $username, string $password, string $role): array;
    public function verify(string $tenantId, string $username, string $password): ?array;
    public function findById(string $tenantId, string $userId): ?array;
    public function deactivateFixture(string $tenantId, string $userId, int $expectedRevision): array;
}

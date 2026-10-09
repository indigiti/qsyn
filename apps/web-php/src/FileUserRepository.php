<?php
declare(strict_types=1);

namespace QSYN\Identity;

use InvalidArgumentException;
use QSYN\Storage\FileStore;
use RuntimeException;

/** Mock/test identities only. No real customer accounts or broker passwords. */
final class FileUserRepository implements UserRepository
{
    private const COLLECTION = 'mock_users';
    private const ROLES = ['viewer', 'member', 'tenant_admin'];
    private const DUMMY_HASH = '$2y$10$zklauoXBrzW0UMJgZ8TfJeyhiVrhhwZm16iiYX/qzBY5icb/wXSDC';

    public function __construct(private FileStore $store) {}

    public static function validTenant(string $value): bool
    {
        return preg_match('/^[a-z][a-z0-9_-]{1,63}$/D', $value) === 1;
    }

    public static function validUsername(string $value): bool
    {
        return preg_match('/^[a-z][a-z0-9_.-]{2,47}$/D', $value) === 1;
    }

    private static function key(string $tenant, string $username): string
    {
        return 'u_' . substr(hash('sha256', $tenant . "\0" . $username), 0, 40);
    }

    private static function publicRecord(array $row): array
    {
        $data = $row['data'] ?? [];
        if (!is_array($data)) {
            throw new RuntimeException('Invalid identity record');
        }
        unset($data['password_hash']);
        return [
            'user_id' => (string) $row['id'],
            'revision' => (int) $row['revision'],
        ] + $data;
    }

    public static function hasRole(array $principal, string $minimum): bool
    {
        $ranking = ['viewer' => 1, 'member' => 2, 'tenant_admin' => 3];
        $actual = (string) ($principal['role'] ?? '');
        return isset($ranking[$actual], $ranking[$minimum])
            && $ranking[$actual] >= $ranking[$minimum]
            && ($principal['status'] ?? null) === 'active';
    }

    public function createFixture(string $tenantId, string $username, string $password, string $role): array
    {
        if (!self::validTenant($tenantId) || !self::validUsername($username)
            || !in_array($role, self::ROLES, true)
            || strlen($password) < 14 || strlen($password) > 72) {
            throw new InvalidArgumentException('Invalid mock user fixture');
        }
        $id = self::key($tenantId, $username);
        $hash = password_hash(
            $password,
            defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT
        );
        $now = gmdate('c');
        return self::publicRecord($this->store->put(self::COLLECTION, $id, [
            'tenant_id' => $tenantId,
            'username' => $username,
            'role' => $role,
            'status' => 'active',
            'password_hash' => $hash,
            'created_at' => $now,
            'updated_at' => $now,
        ]));
    }

    public function verify(string $tenantId, string $username, string $password): ?array
    {
        $valid = self::validTenant($tenantId) && self::validUsername($username)
            && strlen($password) <= 256;
        $row = $valid ? $this->store->get(self::COLLECTION, self::key($tenantId, $username)) : null;
        $hash = $row['data']['password_hash'] ?? null;
        $check = is_string($hash) && strlen($hash) < 256 ? $hash : self::DUMMY_HASH;
        $matches = password_verify($password, $check);
        if (!$valid || !$matches || $row === null || ($row['data']['status'] ?? null) !== 'active') {
            return null;
        }
        return self::publicRecord($row);
    }

    public function findById(string $tenantId, string $userId): ?array
    {
        if (!self::validTenant($tenantId)
            || preg_match('/^u_[a-f0-9]{40}$/D', $userId) !== 1) {
            return null;
        }
        $row = $this->store->get(self::COLLECTION, $userId);
        if ($row === null || ($row['data']['tenant_id'] ?? null) !== $tenantId
            || ($row['data']['status'] ?? null) !== 'active') {
            return null;
        }
        return self::publicRecord($row);
    }

    public function deactivateFixture(string $tenantId, string $userId, int $expectedRevision): array
    {
        $user = $this->findById($tenantId, $userId);
        if ($user === null) {
            throw new RuntimeException('Mock user not found');
        }
        $row = $this->store->get(self::COLLECTION, $userId);
        if ($row === null) {
            throw new RuntimeException('Mock user not found');
        }
        $data = $row['data'];
        $data['status'] = 'disabled';
        $data['updated_at'] = gmdate('c');
        return self::publicRecord($this->store->put(
            self::COLLECTION, $userId, $data, $expectedRevision
        ));
    }
}

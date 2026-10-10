<?php
declare(strict_types=1);

namespace QSYN\Audit;

use InvalidArgumentException;
use RuntimeException;
use QSYN\Storage\FileStore;

/**
 * Development-only, append-only mock audit event store.
 *
 * Write-only from web controllers. Every event is its own private 0600
 * FileStore record, with a random collision-resistant ID. Never persist
 * request bodies, tokens, names, IP addresses or passwords here.
 */
final class FileMockAuditLog
{
    private const COLLECTION = 'mock_audit_events';
    private const EVENTS = [
        'auth.login', 'auth.logout',
        'account.link', 'account.rename', 'account.select', 'account.disconnect',
        'workspace.save',
    ];
    private const STATES = ['intent', 'completed', 'rejected'];

    public function __construct(private FileStore $store) {}

    /**
     * One 256-bit local test signing key in 0600 private storage.
     * Integrity seals detect offline record edits unless the application owner
     * or signing key is also compromised. Neither deletion nor key replacement
     * is detectable by this development-only verifier.
     */
    private function signingKey(bool $create): string
    {
        $root = $this->store->rootPath();
        $path = $root . '/mock-audit-hmac.key';
        $lockPath = $root . '/mock-audit-hmac.lock';
        if (is_link($path) || is_link($lockPath)) {
            throw new RuntimeException('Audit key symlink refused');
        }
        $lock = fopen($lockPath, 'c+');
        if ($lock === false) {
            throw new RuntimeException('Cannot lock mock audit key');
        }
        try {
            chmod($lockPath, 0600);
            if (!flock($lock, LOCK_EX)) {
                throw new RuntimeException('Audit signing key lock unavailable');
            }
            if (is_link($path)) {
                throw new RuntimeException('Audit key symlink refused');
            }
            if (!is_file($path)) {
                if (!$create) {
                    throw new RuntimeException('Audit signing key unavailable');
                }
                $out = fopen($path, 'x');
                if ($out === false) {
                    throw new RuntimeException('Cannot initialize signing key');
                }
                try {
                    chmod($path, 0600);
                    $bytes = bin2hex(random_bytes(32)) . "\n";
                    if (fwrite($out, $bytes) !== strlen($bytes) || !fflush($out)) {
                        throw new RuntimeException('Cannot initialize signing key');
                    }
                    if (function_exists('fsync') && !fsync($out)) {
                        throw new RuntimeException('Cannot synchronize signing key');
                    }
                } finally {
                    fclose($out);
                }
            }
            $mode = fileperms($path);
            if ($mode === false || ($mode & 0077) !== 0) {
                throw new RuntimeException('Unsafe audit signing key permissions');
            }
            $contents = file_get_contents($path);
            if (!is_string($contents) || preg_match('/^[a-f0-9]{64}\n?$/D', $contents) !== 1) {
                throw new RuntimeException('Corrupt audit signing key');
            }
            $raw = hex2bin(trim($contents));
            if ($raw === false) {
                throw new RuntimeException('Invalid audit signing key');
            }
            return $raw;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private static function mac(array $payload, string $key): string
    {
        return hash_hmac(
            'sha256',
            json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
            $key
        );
    }

    /**
     * Offline integrity assessment; do not expose over HTTP.
     * @return array{verified_events:int,integrity:string}
     */
    public function verifyAll(): array
    {
        $key = $this->signingKey(false);
        $records = $this->store->listRecords(self::COLLECTION);
        foreach ($records as $record) {
            $data = $record['data'] ?? null;
            if (!is_array($data) || ($record['revision'] ?? null) !== 1
                || ($record['schema_version'] ?? null) !== 1
                || !isset($data['integrity_hmac'], $data['integrity_version'])
                || $data['integrity_version'] !== 1
                || !is_string($data['integrity_hmac'])
                || preg_match('/^[a-f0-9]{64}$/D', $data['integrity_hmac']) !== 1) {
                throw new RuntimeException('Invalid or unsealed audit record');
            }
            $provided = $data['integrity_hmac'];
            unset($data['integrity_hmac']);
            if (!hash_equals(self::mac($data, $key), $provided)) {
                throw new RuntimeException('Mock audit integrity check failed');
            }
        }
        return ['verified_events' => count($records), 'integrity' => 'hmac-sha256'];
    }

    public function record(
        string $tenant,
        string $actor,
        string $event,
        string $state,
        ?string $resourceId = null,
        ?string $correlationId = null
    ): array {
        if (!preg_match('/^[a-z][a-z0-9_-]{1,63}$/D', $tenant)
            || !preg_match('/^u_[a-f0-9]{40}$/D', $actor)
            || !in_array($event, self::EVENTS, true)
            || !in_array($state, self::STATES, true)
            || ($resourceId !== null && preg_match('/^[a-zA-Z0-9_-]{1,96}$/D', $resourceId) !== 1)
            || ($correlationId !== null && preg_match('/^[a-f0-9]{32}$/D', $correlationId) !== 1)) {
            throw new InvalidArgumentException('Invalid mock audit event');
        }
        $correlationId ??= bin2hex(random_bytes(16));
        $eventId = 'e_' . bin2hex(random_bytes(16));
        $data = [
            'tenant_id' => $tenant,
            'actor_user_id' => $actor,
            'event' => $event,
            'state' => $state,
            'resource_id' => $resourceId,
            'correlation_id' => $correlationId,
            'at' => gmdate('c'),
            'integrity_version' => 1,
        ];
        $data['integrity_hmac'] = self::mac($data, $this->signingKey(true));
        $record = $this->store->put(self::COLLECTION, $eventId, $data);
        return [
            'event_id' => $record['id'],
            'correlation_id' => $correlationId,
        ];
    }
}

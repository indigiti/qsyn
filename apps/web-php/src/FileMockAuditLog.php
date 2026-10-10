<?php
declare(strict_types=1);

namespace QSYN\Audit;

use InvalidArgumentException;
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
        $record = $this->store->put(self::COLLECTION, $eventId, [
            'tenant_id' => $tenant,
            'actor_user_id' => $actor,
            'event' => $event,
            'state' => $state,
            'resource_id' => $resourceId,
            'correlation_id' => $correlationId,
            'at' => gmdate('c'),
        ]);
        return [
            'event_id' => $record['id'],
            'correlation_id' => $correlationId,
        ];
    }
}

<?php
declare(strict_types=1);

namespace QSYN\Terminal;

use InvalidArgumentException;
use RuntimeException;
use QSYN\Storage\FileStore;
use QSYN\Identity\FileUserRepository;
use QSYN\Identity\IdentityApi;
use QSYN\Identity\UserSession;
use QSYN\Audit\FileMockAuditLog;

/**
 * Private development/test terminal workspace HTTP boundary.
 *
 * An independently enabled feature using existing mock identity sessions;
 * never enabled on public QSYN by flipping a browser flag or query string.
 * GET and POST derive tenant+owner exclusively from current session.
 */
final class TerminalWorkspaceApi
{
    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(array $server): array
    {
        $root = IdentityApi::privateRoot();
        if (getenv('QSYN_TERMINAL_FILE_SYNC_ENABLED') !== '1' || $root === null) {
            return [503, ['error' => 'private_terminal_workspace_disabled']];
        }
        if (!UserSession::boot($server)) {
            return [403, ['error' => 'secure_transport_required']];
        }
        $method = (string) ($server['REQUEST_METHOD'] ?? 'GET');
        if (!in_array($method, ['GET', 'POST'], true)) {
            return [405, ['error' => 'method_not_allowed']];
        }
        $store = new FileStore($root);
        $principal = UserSession::principal(new FileUserRepository($store));
        if ($principal === null) {
            return [401, ['error' => 'unauthorized']];
        }
        $tenant = (string) $principal['tenant_id'];
        $owner = (string) $principal['user_id'];
        if (!UserSession::authorized($principal, $tenant, 'viewer')) {
            return [403, ['error' => 'forbidden']];
        }
        $workspaces = new FileTerminalWorkspaceRepository($store);
        if ($method === 'GET') {
            $result = $workspaces->getForOwner($tenant, $owner);
            return [200, [
                'mode' => 'simulated',
                'storage' => 'private_file_development_only',
                'csrf' => UserSession::csrf(),
                'revision' => $result['revision'],
                'workspace' => $result['workspace'],
                'can_write' => UserSession::authorized($principal, $tenant, 'member'),
            ]];
        }
        if (!UserSession::authorized($principal, $tenant, 'member')) {
            return [403, ['error' => 'forbidden']];
        }
        if (!UserSession::originAllowed($server)) {
            return [403, ['error' => 'origin_not_allowed']];
        }
        if (!preg_match('~^application/json(?:\s*;|$)~i', (string) ($server['CONTENT_TYPE'] ?? ''))) {
            return [415, ['error' => 'json_required']];
        }
        $raw = file_get_contents('php://input', false, null, 0, 132001);
        if (!is_string($raw) || strlen($raw) > 132000) {
            return [413, ['error' => 'request_too_large']];
        }
        try {
            $body = json_decode($raw, true, 48, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!is_array($body) || array_is_list($body) ||
            count($body) !== 2 || !array_key_exists('workspace', $body) ||
            !array_key_exists('expected_revision', $body)) {
            return [422, ['error' => 'invalid_workspace_fields']];
        }
        if (!UserSession::verifyCsrf((string) ($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error' => 'csrf_invalid']];
        }
        if (!is_int($body['expected_revision']) || $body['expected_revision'] < 0 ||
            $body['expected_revision'] > 2147483647) {
            return [422, ['error' => 'invalid_revision']];
        }
        try {
            // Validate before audit or disk mutation; no client-controlled keys.
            $validated = FileTerminalWorkspaceRepository::validate($body['workspace']);
            $audit = new FileMockAuditLog($store);
            $intent = $audit->record($tenant, $owner, 'workspace.save', 'intent');
            try {
                $result = $workspaces->saveForOwner(
                    $tenant, $owner, $validated, $body['expected_revision']
                );
            } catch (\Throwable $error) {
                $audit->record($tenant, $owner, 'workspace.save', 'rejected',
                    null, $intent['correlation_id']);
                throw $error;
            }
            $audit->record($tenant, $owner, 'workspace.save', 'completed',
                null, $intent['correlation_id']);
            return [200, [
                'mode' => 'simulated', 'storage' => 'private_file_development_only',
                'revision' => $result['revision'], 'workspace' => $result['workspace'],
            ]];
        } catch (InvalidArgumentException) {
            return [422, ['error' => 'invalid_workspace']];
        } catch (RuntimeException $error) {
            if ($error->getMessage() === 'Revision conflict') {
                return [409, ['error' => 'revision_conflict']];
            }
            throw $error;
        }
    }
}

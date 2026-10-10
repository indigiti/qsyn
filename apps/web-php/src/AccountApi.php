<?php
declare(strict_types=1);

namespace QSYN\Accounts;

use InvalidArgumentException;
use QSYN\Identity\FileUserRepository;
use QSYN\Identity\IdentityApi;
use QSYN\Identity\UserSession;
use QSYN\Storage\FileStore;
use RuntimeException;

/**
 * Authenticated mock metadata only. Explicitly opt-in for local development;
 * never accepts owner/tenant authority from query strings or request bodies.
 */
final class AccountApi
{
    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(string $operation, array $server): array
    {
        // An independent second switch prevents enabling broker account
        // mutations merely by turning on the mock identity fixture API.
        $private = IdentityApi::privateRoot();
        if ($private === null || getenv('QSYN_MOCK_ACCOUNTS_ENABLED') !== '1') {
            return [503, ['error' => 'mock_accounts_not_enabled']];
        }
        if (!UserSession::boot($server)) {
            return [403, ['error' => 'secure_transport_required']];
        }
        $method = in_array($operation, ['list', 'get'], true) ? 'GET' : 'POST';
        if (($server['REQUEST_METHOD'] ?? 'GET') !== $method) {
            return [405, ['error' => 'method_not_allowed']];
        }

        $store = new FileStore($private);
        $principal = UserSession::principal(new FileUserRepository($store));
        if ($principal === null) {
            return [401, ['error' => 'unauthorized']];
        }
        $tenant = (string) $principal['tenant_id'];
        $owner = (string) $principal['user_id'];
        if (!UserSession::authorized($principal, $tenant, 'viewer')) {
            return [403, ['error' => 'forbidden']];
        }
        $accounts = new FileMockBrokerConnectionRepository($store);
        $selection = new FileMockAccountSelection($store, $accounts);

        if ($operation === 'list') {
            return [200, [
                'mode' => 'simulated',
                'accounts' => $accounts->listForOwner($tenant, $owner),
                'selection' => $selection->current($tenant, $owner),
            ]];
        }
        if ($operation === 'get') {
            $id = $_GET['id'] ?? null;
            if (!is_string($id) || strlen($id) > 48) {
                return [404, ['error' => 'account_not_found']];
            }
            try {
                $account = $accounts->getForOwner($tenant, $owner, $id);
            } catch (InvalidArgumentException) {
                $account = null;
            }
            return $account === null
                ? [404, ['error' => 'account_not_found']]
                : [200, ['account' => $account, 'mode' => 'simulated']];
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
        $raw = file_get_contents('php://input', false, null, 0, 4097);
        if (!is_string($raw) || strlen($raw) > 4096) {
            return [413, ['error' => 'request_too_large']];
        }
        try {
            $body = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!is_array($body) || array_is_list($body)) {
            return [400, ['error' => 'invalid_json']];
        }
        if (!UserSession::verifyCsrf((string) ($server['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            return [403, ['error' => 'csrf_invalid']];
        }
        // Fail closed rather than simply ignore client attempts to introduce
        // an alternate tenant, user, privilege or broker execution context.
        foreach (['tenant_id', 'owner_user_id', 'user_id', 'execution_allowed',
            'account_token', 'access_token', 'api_key', 'role'] as $forbidden) {
            if (array_key_exists($forbidden, $body)) {
                return [422, ['error' => 'unsupported_field']];
            }
        }

        try {
            $id = $body['account_id'] ?? null;
            $revision = $body['expected_revision'] ?? null;
            if ($operation === 'link') {
                $broker = $body['broker_code'] ?? null;
                $reference = $body['mock_reference'] ?? null;
                $label = $body['display_label'] ?? null;
                if (!is_string($broker) || !is_string($reference) || !is_string($label)
                    || strlen($broker) > 32 || strlen($reference) > 64 || strlen($label) > 120) {
                    return [422, ['error' => 'invalid_account_fields']];
                }
                return [201, [
                    'account' => $accounts->linkMock($tenant, $owner, $broker, $reference, $label),
                    'mode' => 'simulated',
                ]];
            }
            if (!is_string($id) || strlen($id) > 48 || !is_int($revision)
                || $revision < 0 || $revision > 2147483647) {
                return [422, ['error' => 'invalid_account_fields']];
            }
            if ($operation === 'rename') {
                $label = $body['display_label'] ?? null;
                if (!is_string($label) || strlen($label) > 120 || $revision < 1) {
                    return [422, ['error' => 'invalid_account_fields']];
                }
                return [200, [
                    'account' => $accounts->renameMock($tenant, $owner, $id, $label, $revision),
                    'mode' => 'simulated',
                ]];
            }
            if ($operation === 'select') {
                return [200, [
                    'selection' => $selection->choose($tenant, $owner, $id, $revision),
                    'mode' => 'simulated',
                ]];
            }
            if ($operation === 'disconnect') {
                if ($revision < 1) {
                    return [422, ['error' => 'invalid_account_fields']];
                }
                return [200, [
                    'account' => $accounts->disconnectMock($tenant, $owner, $id, $revision),
                    // The selection may still contain the old ID; current()
                    // masks disconnected accounts without rewriting a second
                    // record inside a non-atomic multi-file transaction.
                    'selection' => $selection->current($tenant, $owner),
                    'mode' => 'simulated',
                ]];
            }
            return [404, ['error' => 'not_found']];
        } catch (InvalidArgumentException) {
            return [422, ['error' => 'invalid_account_fields']];
        } catch (RuntimeException $error) {
            return match ($error->getMessage()) {
                'Mock account not found' => [404, ['error' => 'account_not_found']],
                'Revision conflict', 'Mock broker account already linked' =>
                    [409, ['error' => 'revision_conflict']],
                'Mock account disconnected' => [409, ['error' => 'account_disconnected']],
                default => throw $error,
            };
        }
    }
}

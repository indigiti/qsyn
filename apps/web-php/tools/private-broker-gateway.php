<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require_once dirname(__DIR__) . '/src/OpenAlgoLocalProbe.php';
require_once dirname(__DIR__) . '/src/PrivateBrokerRegistry.php';
require_once dirname(__DIR__) . '/src/PrivateOpenAlgoReader.php';

use QSYN\Broker\PrivateBrokerRegistry as Registry;
use QSYN\Broker\PrivateOpenAlgoReader as OpenAlgo;

try {
    $registryPath = getenv('QSYN_OPENALGO_REGISTRY_FILE');
    if (!is_string($registryPath) || $registryPath === '') {
        throw new RuntimeException('missing_registry');
    }
    $accounts = Registry::load($registryPath);
    $action = $argv[1] ?? '';
    $tenant = $argv[2] ?? '';
    $owner = $argv[3] ?? '';
    if (!is_string($tenant) || !is_string($owner)
        || !preg_match('/^[A-Za-z0-9._-]{1,80}$/D', $tenant)
        || !preg_match('/^[A-Za-z0-9._-]{1,80}$/D', $owner)) {
        throw new RuntimeException('invalid_scope');
    }
    if ($action === 'list' && count($argv) === 4) {
        $allowed = [];
        foreach ($accounts as $account) {
            if ($account['tenant_id'] === $tenant && $account['owner_user_id'] === $owner) {
                $allowed[] = Registry::publicSummary($account);
            }
        }
        $result = [
            'schema' => 'QSYN-PRIVATE-BROKER-INVENTORY/1',
            'accounts' => $allowed,
            'supported_read_operations' => OpenAlgo::capabilities(),
            'trading_enabled' => false,
        ];
    } elseif ($action === 'readiness' && count($argv) === 4) {
        // This private, scoped preflight is an observation, not authorization
        // to redistribute live data or route real broker orders.
        $statuses = [];
        foreach ($accounts as $account) {
            if ($account['tenant_id'] !== $tenant || $account['owner_user_id'] !== $owner) {
                continue;
            }
            $status = Registry::publicSummary($account);
            $responding = false;
            try {
                $ping = OpenAlgo::request($account, 'ping');
                $responding = ($ping['broker_session_responding'] ?? false) === true;
            } catch (Throwable) {
                // Isolate failures and do not disclose broker errors, secrets,
                // private paths, provider responses or other accounts.
            }
            $status['broker_session_responding'] = $responding;
            $status['readiness'] = $responding
                ? 'private_session_only' : 'session_not_verified';
            $statuses[] = $status;
        }
        $result = [
            'schema' => 'QSYN-PRIVATE-BROKER-READINESS/1',
            'accounts' => $statuses,
            'market_entitlement_verified' => false,
            'public_redistribution_allowed' => false,
            'live_chart_ready' => false,
            'order_execution_enabled' => false,
            'operator_activation_required' => true,
            'ui_mode' => 'unchanged',
        ];
    } elseif ($action === 'read' && (count($argv) === 6 || count($argv) === 7)) {
        $accountId = $argv[4];
        $operation = $argv[5];
        if (!is_string($accountId) || !is_string($operation)) {
            throw new RuntimeException('invalid_command');
        }
        $account = Registry::connection($accounts, $tenant, $owner, $accountId);
        $args = [];
        if (isset($argv[6])) {
            if (strlen($argv[6]) > 2048) {
                throw new RuntimeException('query_too_large');
            }
            $args = json_decode($argv[6], true, 12, JSON_THROW_ON_ERROR);
            if (!is_array($args) || (array_is_list($args) && $args !== [])) {
                throw new RuntimeException('invalid_query');
            }
        }
        $result = OpenAlgo::request($account, $operation, $args);
    } else {
        throw new RuntimeException('unsupported_command');
    }
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
} catch (Throwable) {
    // No secrets, account IDs, provider body, input data or private paths
    // should ever be printed to CI, the web or operator shell errors.
    fwrite(STDERR, "QSYN private OpenAlgo broker command rejected; verify operator access and configuration.\n");
    exit(2);
}

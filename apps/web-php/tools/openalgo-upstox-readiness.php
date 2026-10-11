<?php
declare(strict_types=1);

// OPERATOR CLI ONLY. No new web endpoint, order path, service start, or OAuth exchange.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/src/OpenAlgoLocalProbe.php';
require_once dirname(__DIR__) . '/src/PrivateBrokerRegistry.php';
require_once dirname(__DIR__) . '/src/PrivateOpenAlgoReader.php';
require_once dirname(__DIR__) . '/src/OpenAlgoBrokerConnectionsApi.php';

use QSYN\Broker\PrivateBrokerRegistry as Registry;
use QSYN\Broker\PrivateOpenAlgoReader as Reader;
use QSYN\Broker\OpenAlgoBrokerConnectionsApi as Connections;

try {
    if (count($argv) !== 5 || $argv[1] !== 'inspect'
        || getenv('QSYN_PRIVATE_BROKER_GATEWAY') !== '1'
        || getenv('QSYN_TRADING_ENABLED') === '1'
        || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') {
        throw new RuntimeException('disabled_or_invalid_command');
    }
    [$script, $operation, $tenant, $owner, $accountId] = $argv;
    foreach ([$tenant, $owner, $accountId] as $scope) {
        if (!is_string($scope) || preg_match('/^[a-zA-Z0-9._-]{1,80}$/D', $scope) !== 1) {
            throw new RuntimeException('invalid_scope');
        }
    }
    $registryPath = (string) (getenv('QSYN_OPENALGO_REGISTRY_FILE') ?: '');
    $linksPath = (string) (getenv('QSYN_OPENALGO_LOGIN_URLS_FILE') ?: '');
    if ($linksPath === '') {
        throw new RuntimeException('missing_approved_login_mapping');
    }
    $account = Registry::connection(Registry::load($registryPath), $tenant, $owner, $accountId);
    if ($account['broker'] !== 'upstox') {
        throw new RuntimeException('requires_upstox_broker_plugin');
    }
    $links = Connections::configuredLoginUrls($linksPath);
    if (!isset($links[$accountId])) {
        throw new RuntimeException('login_not_provisioned');
    }

    // This ping proves ONLY that the local OpenAlgo application API responds
    // with the pinned plugin. It does not prove the user UCC, licensed market
    // data, actual Upstox account identity, or authorization to place orders.
    $responding = false;
    try {
        $result = Reader::request($account, 'ping');
        $responding = ($result['broker_session_responding'] ?? false) === true
            && ($result['broker'] ?? null) === 'upstox'
            && ($result['source'] ?? null) === 'authenticated_openalgo_loopback';
    } catch (Throwable) {
        // A missing, expired or unreachable session is a normal negative result.
        // Do not echo provider errors or file paths.
    }

    $report = [
        'schema' => 'QSYN-OPENALGO-UPSTOX-OPERATOR-READINESS/1',
        'account_id' => $accountId,
        'broker' => 'upstox',
        'upstream_login_configured' => true,
        'oauth_callback_path' => '/upstox/callback',
        'openalgo_application_session_responding' => $responding,
        'session_state' => $responding ? 'openalgo_session_responding' : 'unavailable_or_expired',
        'upstox_account_identity_verified' => false,
        'broker_oauth_callback_verified' => false,
        'exchange_display_rights_verified' => false,
        'live_feed_verified' => false,
        'trading_enabled_in_qsyn' => false,
        'openalgo_trading_permissions_verified' => false,
        'cloudways_host_approved' => false,
        'ready_for_live_market_data' => false,
    ];
    echo json_encode($report, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
    exit($responding ? 0 : 3);
} catch (Throwable) {
    // CLI errors are intentionally opaque: no keys, OAuth data, URLs or private paths.
    fwrite(STDERR, "QSYN OpenAlgo Upstox readiness rejected; review private operator configuration.\n");
    exit(2);
}

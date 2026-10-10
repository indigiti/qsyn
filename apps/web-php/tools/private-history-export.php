<?php
declare(strict_types=1);

/* Operator-only OpenAlgo -> normalized private historical leg export.
   Does not infer exchange redistribution rights or modify public QSYN Studio. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__) . '/src/OpenAlgoLocalProbe.php';
require_once dirname(__DIR__) . '/src/PrivateBrokerRegistry.php';
require_once dirname(__DIR__) . '/src/PrivateOpenAlgoReader.php';

use QSYN\Broker\PrivateBrokerRegistry as Registry;
use QSYN\Broker\PrivateOpenAlgoReader as Reader;

try {
    if (getenv('QSYN_PRIVATE_HISTORY_EXPORT_ENABLED') !== '1'
        || getenv('QSYN_TRADING_ENABLED') === '1'
        || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') {
        throw new RuntimeException('history_export_disabled');
    }
    if (count($argv) !== 10 || ($argv[1] ?? '') !== 'export') {
        throw new RuntimeException('invalid_history_export_arguments');
    }
    [$script, $command, $tenant, $owner, $accountId, $symbol, $exchange,
        $start, $end, $output] = $argv;
    $regPath = getenv('QSYN_OPENALGO_REGISTRY_FILE');
    $attestPath = getenv('QSYN_HISTORY_LICENSE_ATTESTATION_FILE');
    if (!is_string($regPath) || !is_string($attestPath)) {
        throw new RuntimeException('private_registry_or_license_missing');
    }
    $account = Registry::connection(Registry::load($regPath), $tenant, $owner, $accountId);
    $legal = json_decode(
        file_get_contents(Registry::privateFile($attestPath)), true, 16, JSON_THROW_ON_ERROR
    );
    $now = (int) floor(microtime(true) * 1000);
    if (!is_array($legal)
        || ($legal['schema'] ?? null) !== 'QSYN-PRIVATE-HISTORY-RETENTION/1'
        || ($legal['tenant'] ?? null) !== $tenant
        || ($legal['owner'] ?? null) !== $owner
        || ($legal['account'] ?? null) !== $accountId
        || ($legal['broker'] ?? null) !== $account['broker']
        || ($legal['private_retention_approved'] ?? null) !== true
        || !is_int($legal['license_expires_ms'] ?? null)
        || $legal['license_expires_ms'] <= $now
        || !in_array($exchange . '|' . $symbol, $legal['instruments'] ?? [], true)
        || !is_string($legal['license_id'] ?? null)
        || preg_match('/^[A-Za-z0-9._:-]{1,100}$/D', $legal['license_id']) !== 1) {
        throw new RuntimeException('history_rights_not_attested');
    }
    // Reader enforces read-only endpoint, instruments, interval and 31-day window.
    $response = Reader::request($account, 'history', [
        'symbol' => $symbol, 'exchange' => $exchange, 'interval' => '1m',
        'start_date' => $start, 'end_date' => $end,
    ]);
    $bars = $response['bars'] ?? null;
    if (!is_array($bars) || count($bars) === 0 || count($bars) > 10000) {
        throw new RuntimeException('empty_or_oversized_provider_history');
    }
    $candles = [];
    $partition = null;
    $previous = 0;
    foreach ($bars as $bar) {
        $timestamp = new DateTimeImmutable($bar['timestamp']);
        $stamp = ((int) $timestamp->format('U')) * 1000;
        $minute = intdiv($stamp, 60000) * 60000;
        $p = gmdate('Ym', intdiv($minute, 1000));
        if ($partition === null) $partition = $p;
        if ($p !== $partition || $minute <= $previous || $minute > $now
            || $minute !== $stamp) {
            throw new RuntimeException('invalid_or_cross_partition_history');
        }
        $previous = $minute;
        $candles[] = [
            'open_time_ms' => $minute,
            'open' => (float) $bar['open'],
            'high' => (float) $bar['high'],
            'low' => (float) $bar['low'],
            'close' => (float) $bar['close'],
            // Trade volume is not synthetic OHLC evidence.
            'observations' => 1,
        ];
    }
    if (!is_string($output) || !str_starts_with($output, '/')
        || is_link($output) || file_exists($output)) {
        throw new RuntimeException('new_absolute_private_export_required');
    }
    $parent = dirname($output);
    $parentReal = realpath($parent);
    if ($parentReal === false || $parentReal !== $parent
        || preg_match('~/(?:public_html|public|webroot|www)(?:/|$)~i', $parent)
        || (fileperms($parent) & 0077) !== 0) {
        throw new RuntimeException('unsafe_history_export_root');
    }
    $payload = [
        'schema' => 'QSYN-OPENALGO-HISTORY-IMPORT/1',
        'source' => 'openalgo_private_rest',
        'broker' => $account['broker'],
        'scope' => [
            'tenant_id' => $tenant, 'account_id' => $accountId,
            'source_id' => 'openalgo_leg_history',
            'entitlement_id' => $legal['license_id'],
        ],
        'series_id' => 'LEG_' . strtoupper(substr(hash('sha256', "$exchange|$symbol"), 0, 24)),
        'partition' => $partition,
        'interval_ms' => 60000,
        'provider_authenticated' => true,
        'retention_rights_attested' => true,
        'license_expires_ms' => $legal['license_expires_ms'],
        'exported_at_ms' => $now,
        'candles' => $candles,
    ];
    $json = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    // Exclusive creation, no accidental overwrite. Caller must use a
    // preexisting owner-only private 0700 directory.
    $fp = @fopen($output, 'x');
    if ($fp === false) throw new RuntimeException('exclusive_export_creation_failed');
    try {
        chmod($output, 0600);
        if (fwrite($fp, $json) !== strlen($json) || fflush($fp) === false) {
            throw new RuntimeException('private_history_export_write_failed');
        }
    } finally { fclose($fp); }
    echo json_encode([
        'schema' => 'QSYN-HISTORY-PRIVATE-EXPORT-RESULT/1',
        'count' => count($candles), 'partition' => $partition,
        'public_distribution' => false, 'orders_enabled' => false,
    ], JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable) {
    fwrite(STDERR, "QSYN historical export denied or unavailable; verify account and private approval.\n");
    exit(2);
}

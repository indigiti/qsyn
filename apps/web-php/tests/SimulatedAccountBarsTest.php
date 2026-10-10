<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/SimulatedAccountBars.php';

use QSYN\Accounts\SimulatedAccountBars;

$a = SimulatedAccountBars::make([
    'account_id' => 'a0798c2f-16b8-5f09-a804-1f641325f126',
    'broker_code' => 'upstox',
], 1780000100);
$b = SimulatedAccountBars::make([
    'account_id' => 'ee4f89a3-8cf8-5105-8d02-e5be51ebd9d2',
    'broker_code' => 'dhan',
], 1780000100);

function expectBars(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}
expectBars($a['mode'] === 'simulated' && $a['source'] === 'account-scoped-mock-fixture',
    'Mock bars incorrectly label their provenance');
expectBars($a['trading_enabled'] === false && $a['symbol'] === 'QSYN-MOCK',
    'Chart bars must never indicate a trading channel');
expectBars(count($a['bars']) === 120 && count($b['bars']) === 120, 'Incorrect mock history length');
expectBars($a['bars'] !== $b['bars'], 'Two accounts must have distinct mock price sequences');
expectBars($a['bars'] === SimulatedAccountBars::make([
    'account_id' => $a['account_id'], 'broker_code' => 'upstox',
], 1780000100)['bars'], 'Mock fixture is nondeterministic');
expectBars($a['bars'][119]['time'] === intdiv(1780000100, 60) * 60,
    'Most recent synthetic bar timestamp invalid');
foreach ($a['bars'] as $index => $bar) {
    expectBars($bar['low'] <= $bar['open'] && $bar['low'] <= $bar['close']
        && $bar['high'] >= $bar['open'] && $bar['high'] >= $bar['close'],
        'OHLC bounds invalid');
    expectBars($bar['volume'] === 0, 'Fake bars must not imply real traded volume');
    if ($index > 0) expectBars($bar['time'] - $a['bars'][$index - 1]['time'] === 60,
        'Simulated candle times must be one minute apart');
}
echo "PASS: deterministic distinct account-scoped synthetic OHLC with truthful provenance\n";

<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/SimulatedOptionsStudio.php';
require dirname(__DIR__) . '/src/StudioAnalytics.php';

use QSYN\Studio\SimulatedOptionsStudio as Studio;
use QSYN\Studio\StudioAnalytics as Analytics;

function need(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}
$now = 1791600000;
foreach (['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as $underlying) {
    $market = Studio::market($underlying, $now);
    $atm = $market['atm'];
    $legs = [
        ['type' => 'CE', 'side' => 'BUY', 'strike' => $atm, 'qty' => 1],
        ['type' => 'PE', 'side' => 'BUY', 'strike' => $atm, 'qty' => 1],
    ];
    $json = json_encode($legs, JSON_THROW_ON_ERROR);
    $data = Studio::bars($underlying, 'W1', '1m', $json, $now);
    $a = Analytics::summarize($data);
    need($a['mode'] === 'simulated' && $a['trading_enabled'] === false
        && $a['model'] === 'fixed-volatility-educational-scenario', 'Invalid provenance');
    need($a['assumptions']['volatility'] === 0.20
        && $a['assumptions']['lot_multiplier'] === 1, 'Missing model assumptions');
    need(count($a['scenario_risk']['breakevens_within_sample']) === 2, 'Long ATM straddle breakevens');
    need($a['scenario_risk']['global_max_gain_known'] === false
        && $a['scenario_risk']['global_max_loss_known'] === false, 'Unsafe global loss claims');
    need(abs($a['greeks']['delta']) <= 2.01 && $a['greeks']['gamma'] > 0.0
        && $a['greeks']['vega_per_pct'] > 0.0 && $a['greeks']['theta_per_day'] < 0.0,
        'Long straddle theoretical Greek signs');
    need($a['history']['samples'] === 120
        && $a['history']['max_drawdown_premium_points'] >= 0, 'History summary invalid');
    $short = $legs;
    foreach ($short as &$leg) $leg['side'] = 'SELL';
    unset($leg);
    $b = Analytics::summarize(Studio::bars($underlying, 'W1', '1m',
        json_encode($short, JSON_THROW_ON_ERROR), $now));
    need($b['greeks']['gamma'] < 0.0 && $b['greeks']['vega_per_pct'] < 0.0
        && $b['greeks']['theta_per_day'] > 0.0, 'Short Greek signs');
}
try {
    Analytics::summarize(['mode' => 'live', 'trading_enabled' => true]);
    throw new RuntimeException('Live or malformed data accepted');
} catch (InvalidArgumentException $expected) {
    // fail closed
}
echo "PASS: simulated option risk, 120-bar history, sampled breakevens and signed Greeks\n";

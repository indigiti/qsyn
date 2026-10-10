<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/SimulatedOptionsStudio.php';

use QSYN\Studio\SimulatedOptionsStudio as Studio;

function expect(bool $good, string $message): void
{
    if (!$good) {
        throw new RuntimeException($message);
    }
}
function rejects(callable $action): void
{
    try {
        $action();
    } catch (InvalidArgumentException) {
        return;
    }
    throw new RuntimeException('Unsafe strategy was accepted');
}
$now = 1791600000;
$market = Studio::market('NIFTY', $now);
expect($market['mode'] === 'simulated' && $market['broker_connected'] === false
    && $market['trading_enabled'] === false, 'Live-market claim escaped');
expect(count($market['chain']) === 13 && $market['strike_step'] === 50, 'Chain invalid');
$atm = $market['atm'];
$legs = [
    ['type' => 'CE', 'side' => 'BUY', 'strike' => $atm, 'qty' => 1],
    ['type' => 'PE', 'side' => 'BUY', 'strike' => $atm, 'qty' => 1],
];
$raw = json_encode($legs, JSON_THROW_ON_ERROR);
foreach (['1m' => 60, '5m' => 300, '15m' => 900] as $interval => $seconds) {
    $a = Studio::bars('NIFTY', 'W1', $interval, $raw, $now);
    $b = Studio::bars('NIFTY', 'W1', $interval, $raw, $now);
    expect($a === $b, 'Same simulated request is nondeterministic');
    expect($a['source'] === 'deterministic-options-laboratory'
        && $a['mode'] === 'simulated' && $a['trading_enabled'] === false
        && $a['synthetic_extrema'] === 'synchronized_15_second_samples', 'Source contract invalid');
    expect(count($a['bars']) === 120 && count($a['legs']) === 2
        && count($a['payoff']) === 21, 'Historical shape invalid');
    $foundDifferentExtrema = false;
    for ($i = 0; $i < 120; $i++) {
        $bar = $a['bars'][$i];
        $ce = $a['legs'][0]['bars'][$i];
        $pe = $a['legs'][1]['bars'][$i];
        expect($bar['time'] % $seconds === 0, 'Unaligned time boundary');
        if ($i > 0) expect($bar['time'] - $a['bars'][$i - 1]['time'] === $seconds, 'Candle gap');
        foreach (['open', 'close'] as $key) {
            expect(abs($bar[$key] - ($ce[$key] + $pe[$key])) <= .02,
                'Basket extrema input is not synchronized at ' . $key);
        }
        expect($bar['high'] >= max($bar['open'], $bar['close'])
            && $bar['low'] <= min($bar['open'], $bar['close']), 'Inconsistent OHLC');
        expect($bar['high'] <= $ce['high'] + $pe['high'] + .02
            && $bar['low'] >= $ce['low'] + $pe['low'] - .02,
            'Aggregate exceeds mathematical component bounds');
        if (abs($bar['high'] - ($ce['high'] + $pe['high'])) > .05
            || abs($bar['low'] - ($ce['low'] + $pe['low'])) > .05) {
            $foundDifferentExtrema = true;
        }
        expect($bar['volume'] === 0, 'Synthetic volume masquerades as exchange volume');
    }
    expect($foundDifferentExtrema, 'Aggregate OHLC mistakenly sums leg highs/lows');
    expect($a['payoff'][0]['pnl'] > $a['payoff'][10]['pnl']
        && $a['payoff'][20]['pnl'] > $a['payoff'][10]['pnl'],
        'Long straddle payoff is not convex');
}

$shortLegs = [
    ['type' => 'CE', 'side' => 'SELL', 'strike' => $atm + 50, 'qty' => 2],
    ['type' => 'PE', 'side' => 'SELL', 'strike' => $atm - 50, 'qty' => 2],
];
$short = Studio::bars('NIFTY', 'W2', '5m', json_encode($shortLegs, JSON_THROW_ON_ERROR), $now);
expect($short['entry_cashflow_points'] > 0, 'Short strategy lacks initial credit');
expect($short['payoff'][10]['pnl'] > $short['payoff'][0]['pnl'],
    'Short strangle payoff is not center-weighted');
expect(Studio::market('FINNIFTY', $now)['underlying'] === 'FINNIFTY', 'Multi-underlying missing');
expect(Studio::market('BANKNIFTY', $now)['strike_step'] === 100, 'Bank strike grid missing');

foreach (['XYZ', '../NIFTY', '<script>'] as $bad) rejects(static fn() => Studio::market($bad));
rejects(static fn() => Studio::bars('NIFTY', 'D1', '1m', $raw));
rejects(static fn() => Studio::bars('NIFTY', 'W1', '2m', $raw));
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m', '{}'));
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m', str_repeat('x', 1500)));
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m', '[]'));
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m',
    json_encode([$legs[0], $legs[0]], JSON_THROW_ON_ERROR)));
$malicious = $legs;
$malicious[0]['qty'] = 10000;
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m',
    json_encode($malicious, JSON_THROW_ON_ERROR)));
$malicious = $legs;
$malicious[0]['strike'] = $atm + 10000;
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m',
    json_encode($malicious, JSON_THROW_ON_ERROR)));
$malicious = $legs;
$malicious[0]['account_id'] = 'not_allowed';
rejects(static fn() => Studio::bars('NIFTY', 'W1', '1m',
    json_encode($malicious, JSON_THROW_ON_ERROR)));

echo "PASS: 3 intervals, multi-underlying pricing, synchronized basket OHLC, payoff and unsafe-request denials\n";

<?php
declare(strict_types=1);

namespace QSYN\Studio;

/**
 * Public, read-only, fully simulated options laboratory.
 * There is no exchange contract, entitlement, credential, order, or live feed.
 * Intrabar synthetic extrema are calculated from time-aligned sampled leg prices,
 * NEVER from summed independent component highs and lows.
 */
final class SimulatedOptionsStudio
{
    private const UNDERLYINGS = [
        'NIFTY' => ['base' => 24500, 'step' => 50, 'label' => 'NIFTY (demo)'],
        'BANKNIFTY' => ['base' => 53500, 'step' => 100, 'label' => 'BANK NIFTY (demo)'],
        'FINNIFTY' => ['base' => 26500, 'step' => 50, 'label' => 'FIN NIFTY (demo)'],
    ];
    private const EXPIRIES = ['W1' => 1.0, 'W2' => 1.42, 'M1' => 2.05];
    private const INTERVALS = ['1m' => 1, '5m' => 5, '15m' => 15];

    private static function symbol(string $value): array
    {
        if (!isset(self::UNDERLYINGS[$value])) {
            throw new \InvalidArgumentException('unsupported_demo_underlying');
        }
        return self::UNDERLYINGS[$value];
    }

    private static function expiry(string $value): float
    {
        if (!isset(self::EXPIRIES[$value])) {
            throw new \InvalidArgumentException('unsupported_demo_expiry');
        }
        return self::EXPIRIES[$value];
    }

    private static function price(int $base, int $step, int $tick, int $strike, string $type, float $tenor): float
    {
        // Every chart uses the same deterministic 15-second simulated spot path.
        $spot = self::spotAt($base, $tick);
        $intrinsic = $type === 'CE' ? max(0.0, $spot - $strike) : max(0.0, $strike - $spot);
        $distance = abs($strike - $spot) / $step;
        $extrinsic = (29.0 * $tenor + 13.0 * exp(-$distance / 3.5)) *
            (1.0 + 0.065 * sin($tick / 31.0 + $strike / $step + ($type === 'CE' ? 0 : 2.4)));
        return round(max(0.05, $intrinsic + $extrinsic), 2);
    }

    private static function spotAt(int $base, int $tick): float
    {
        return $base + 64.0 * sin($tick / 37.0) + 29.0 * cos($tick / 89.0)
            + 11.0 * sin($tick / 8.0);
    }

    private static function lastTick(?int $now = null): int
    {
        $minute = intdiv($now ?? time(), 60);
        return $minute * 4;
    }

    public static function market(string $underlying, ?int $now = null): array
    {
        $config = self::symbol($underlying);
        $base = $config['base'];
        $step = $config['step'];
        $tick = self::lastTick($now);
        $spot = round(self::spotAt($base, $tick), 2);
        $atm = (int) (round($spot / $step) * $step);
        $chain = [];
        for ($i = -6; $i <= 6; $i++) {
            $strike = $atm + $i * $step;
            $chain[] = [
                'strike' => $strike,
                'ce' => self::price($base, $step, $tick, $strike, 'CE', 1.0),
                'pe' => self::price($base, $step, $tick, $strike, 'PE', 1.0),
            ];
        }
        return [
            'mode' => 'simulated', 'source' => 'deterministic-options-laboratory',
            'trading_enabled' => false, 'broker_connected' => false,
            'underlying' => $underlying, 'label' => $config['label'],
            'spot' => $spot, 'atm' => $atm, 'strike_step' => $step,
            'expiries' => array_keys(self::EXPIRIES),
            'intervals' => array_keys(self::INTERVALS),
            'chain' => $chain, 'simulation_note' => 'Fictional prices; not exchange quotes or actionable trading signals',
        ];
    }

    private static function legs(string $raw, int $base, int $step): array
    {
        if ($raw === '' || strlen($raw) > 1400) {
            throw new \InvalidArgumentException('invalid_legs_size');
        }
        try {
            $decoded = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new \InvalidArgumentException('invalid_legs_json', 0, $error);
        }
        if (!is_array($decoded) || !array_is_list($decoded) || count($decoded) < 1 || count($decoded) > 4) {
            throw new \InvalidArgumentException('invalid_legs_count');
        }
        $result = [];
        $seen = [];
        foreach ($decoded as $leg) {
            if (!is_array($leg) || array_keys($leg) !== ['type', 'side', 'strike', 'qty']
                || !in_array($leg['type'], ['CE', 'PE'], true)
                || !in_array($leg['side'], ['BUY', 'SELL'], true)
                || !is_int($leg['strike']) || $leg['strike'] % $step !== 0
                || abs($leg['strike'] - $base) > $step * 20
                || !is_int($leg['qty']) || $leg['qty'] < 1 || $leg['qty'] > 5) {
                throw new \InvalidArgumentException('invalid_demo_leg');
            }
            $key = $leg['type'] . ':' . $leg['strike'];
            if (isset($seen[$key])) {
                throw new \InvalidArgumentException('duplicate_demo_contract');
            }
            $seen[$key] = true;
            $result[] = $leg;
        }
        return $result;
    }

    private static function candle(array $prices, int $time): array
    {
        $open = $prices[0];
        $close = $prices[count($prices) - 1];
        return [
            'time' => $time, 'open' => $open,
            'high' => max($prices), 'low' => min($prices),
            'close' => $close, 'volume' => 0,
        ];
    }

    public static function bars(string $underlying, string $expiry, string $interval, string $rawLegs, ?int $now = null): array
    {
        $config = self::symbol($underlying);
        $tenor = self::expiry($expiry);
        if (!isset(self::INTERVALS[$interval])) {
            throw new \InvalidArgumentException('unsupported_demo_interval');
        }
        $base = $config['base'];
        $step = $config['step'];
        $legs = self::legs($rawLegs, $base, $step);
        $intervalMinutes = self::INTERVALS[$interval];
        $end = intdiv($now ?? time(), $intervalMinutes * 60) * $intervalMinutes * 60;
        $combined = [];
        $spotBars = [];
        $legSeries = array_map(static fn(array $leg): array => [
            'type' => $leg['type'], 'side' => $leg['side'],
            'strike' => $leg['strike'], 'qty' => $leg['qty'], 'bars' => [],
        ], $legs);

        for ($i = 119; $i >= 0; --$i) {
            $time = $end - $i * $intervalMinutes * 60;
            $openingTick = intdiv($time, 60) * 4;
            $total = [];
            $spots = [];
            $individual = array_fill(0, count($legs), []);
            // Every sample is synchronous across all legs. This is intentional:
            // adding independently observed CE-high and PE-high would be wrong.
            for ($sample = 0; $sample < $intervalMinutes * 4; ++$sample) {
                $tick = $openingTick + $sample;
                $spots[] = round(self::spotAt($base, $tick), 2);
                $premium = 0.0;
                foreach ($legs as $k => $leg) {
                    $price = self::price($base, $step, $tick, $leg['strike'], $leg['type'], $tenor);
                    $individual[$k][] = $price;
                    // Combined PREMIUM is a positive magnitude. BUY/SELL affects payoff,
                    // not the observed premium basket.
                    $premium += $price * $leg['qty'];
                }
                $total[] = round($premium, 2);
            }
            $combined[] = self::candle($total, $time);
            $spotBars[] = self::candle($spots, $time);
            foreach ($individual as $k => $values) {
                $legSeries[$k]['bars'][] = self::candle($values, $time);
            }
        }

        $lastTick = intdiv($end, 60) * 4 + $intervalMinutes * 4 - 1;
        $entry = 0.0;
        $marks = [];
        foreach ($legs as $leg) {
            $mark = self::price($base, $step, $lastTick, $leg['strike'], $leg['type'], $tenor);
            $marks[] = $mark;
            $entry += ($leg['side'] === 'BUY' ? -1 : 1) * $leg['qty'] * $mark;
        }
        $payoff = [];
        $atm = (int) (round(self::spotAt($base, $lastTick) / $step) * $step);
        for ($offset = -10; $offset <= 10; ++$offset) {
            $settlement = $atm + $offset * $step;
            $pnl = 0.0;
            foreach ($legs as $k => $leg) {
                $intrinsic = $leg['type'] === 'CE'
                    ? max(0, $settlement - $leg['strike'])
                    : max(0, $leg['strike'] - $settlement);
                $pnl += ($leg['side'] === 'BUY' ? 1 : -1) * $leg['qty'] * ($intrinsic - $marks[$k]);
            }
            $payoff[] = ['spot' => $settlement, 'pnl' => round($pnl, 2)];
        }

        return [
            'mode' => 'simulated', 'source' => 'deterministic-options-laboratory',
            'trading_enabled' => false, 'broker_connected' => false,
            'underlying' => $underlying, 'expiry' => $expiry,
            'interval' => $interval, 'symbol' => 'QSYN-PREMIUM-DEMO',
            'exchange' => 'QSYN', 'bars' => $combined, 'underlying_bars' => $spotBars,
            'legs' => $legSeries, 'entry_cashflow_points' => round($entry, 2),
            'payoff' => $payoff, 'units' => 'fictional premium points; not INR or lot-adjusted',
            'synthetic_extrema' => 'synchronized_15_second_samples',
        ];
    }
}

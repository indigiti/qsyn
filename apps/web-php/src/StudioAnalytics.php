<?php
declare(strict_types=1);

namespace QSYN\Studio;

/**
 * Read-only educational risk summaries of the deterministic QSYN options lab.
 * Figures are fictional points. Greeks use a FIXED textbook volatility/rate,
 * not implied vol, a broker source, exchange strikes, or executable quotes.
 */
final class StudioAnalytics
{
    private static function nPdf(float $x): float
    {
        return exp(-0.5 * $x * $x) / sqrt(2.0 * M_PI);
    }

    private static function nCdf(float $x): float
    {
        // Abramowitz-Stegun normal CDF approximation; bounded and monotone.
        if ($x < 0.0) {
            return 1.0 - self::nCdf(-$x);
        }
        $t = 1.0 / (1.0 + 0.2316419 * $x);
        $poly = $t * (0.319381530 + $t * (-0.356563782 + $t *
            (1.781477937 + $t * (-1.821255978 + 1.330274429 * $t))));
        return 1.0 - self::nPdf($x) * $poly;
    }

    private static function greek(string $type, float $spot, float $strike, float $time): array
    {
        $sigma = 0.20;
        $rate = 0.0;
        $sqrt = sqrt($time);
        $d1 = (log($spot / $strike) + ($rate + $sigma * $sigma / 2.0) * $time)
            / ($sigma * $sqrt);
        $d2 = $d1 - $sigma * $sqrt;
        $pdf = self::nPdf($d1);
        $delta = $type === 'CE' ? self::nCdf($d1) : self::nCdf($d1) - 1.0;
        $gamma = $pdf / ($spot * $sigma * $sqrt);
        $vega = $spot * $pdf * $sqrt / 100.0; // per 1 volatility percentage point
        $theta = -(($spot * $pdf * $sigma) / (2.0 * $sqrt)) / 365.0; // per calendar day
        if ($type === 'PE') {
            // r=0: call and put theta are the same in the simplified model.
            $theta += $rate * $strike * exp(-$rate * $time) * self::nCdf(-$d2) / 365.0;
        }
        return ['delta' => $delta, 'gamma' => $gamma, 'vega_per_pct' => $vega,
            'theta_per_day' => $theta];
    }

    public static function summarize(array $series): array
    {
        if (($series['mode'] ?? null) !== 'simulated' || ($series['trading_enabled'] ?? null) !== false
            || ($series['broker_connected'] ?? null) !== false
            || !is_array($series['bars'] ?? null) || count($series['bars']) !== 120
            || !is_array($series['underlying_bars'] ?? null)
            || !is_array($series['legs'] ?? null) || !is_array($series['payoff'] ?? null)) {
            throw new \InvalidArgumentException('unsupported_studio_analytics_source');
        }

        $payoff = $series['payoff'];
        $min = min(array_column($payoff, 'pnl'));
        $max = max(array_column($payoff, 'pnl'));
        $crossings = [];
        for ($i = 1; $i < count($payoff); ++$i) {
            $prev = $payoff[$i - 1];
            $next = $payoff[$i];
            $a = (float) $prev['pnl'];
            $b = (float) $next['pnl'];
            if ($a === 0.0) {
                $crossings[] = (float) $prev['spot'];
            } elseif ($a * $b < 0.0) {
                $crossings[] = (float) $prev['spot'] + (float) ($next['spot'] - $prev['spot'])
                    * (-$a / ($b - $a));
            }
        }
        if ((float) end($payoff)['pnl'] === 0.0) {
            $crossings[] = (float) end($payoff)['spot'];
        }
        $crossings = array_values(array_unique(array_map(static fn(float $n): float => round($n, 2), $crossings)));

        $bars = $series['bars'];
        $peak = 0.0;
        $drawdown = 0.0;
        $change = [];
        foreach ($bars as $bar) {
            $close = (float) $bar['close'];
            $peak = max($peak, $close);
            $drawdown = max($drawdown, $peak - $close);
            $change[] = $close;
        }
        $spot = (float) end($series['underlying_bars'])['close'];
        $t = match ($series['expiry']) {
            'W1' => 7.0 / 365.0, 'W2' => 14.0 / 365.0, 'M1' => 30.0 / 365.0,
            default => throw new \InvalidArgumentException('unknown_demo_horizon'),
        };
        $portfolio = ['delta' => 0.0, 'gamma' => 0.0,
            'vega_per_pct' => 0.0, 'theta_per_day' => 0.0];
        foreach ($series['legs'] as $leg) {
            if (!in_array($leg['type'] ?? null, ['CE', 'PE'], true)
                || !in_array($leg['side'] ?? null, ['BUY', 'SELL'], true)) {
                throw new \InvalidArgumentException('invalid_demo_analytics_leg');
            }
            $contract = self::greek($leg['type'], $spot, (float) $leg['strike'], $t);
            $signed = ($leg['side'] === 'BUY' ? 1 : -1) * (int) $leg['qty'];
            foreach ($portfolio as $name => $value) {
                $portfolio[$name] += $signed * $contract[$name];
            }
        }
        foreach ($portfolio as $name => $value) {
            $portfolio[$name] = round($value, $name === 'gamma' ? 6 : 3);
        }

        return [
            'model' => 'fixed-volatility-educational-scenario',
            'mode' => 'simulated', 'trading_enabled' => false,
            'assumptions' => [
                'volatility' => 0.20, 'risk_free_rate' => 0.0, 'dividend_yield' => 0.0,
                'time_to_expiry_days' => round($t * 365.0), 'lot_multiplier' => 1,
            ],
            'greeks' => $portfolio,
            'scenario_risk' => [
                'min_pnl_points' => round($min, 2),
                'max_pnl_points' => round($max, 2),
                'breakevens_within_sample' => $crossings,
                'scenario_range' => [
                    'from' => $payoff[0]['spot'], 'to' => end($payoff)['spot'],
                ],
                'global_max_loss_known' => false,
                'global_max_gain_known' => false,
            ],
            'history' => [
                'samples' => count($bars),
                'first_time' => $bars[0]['time'],
                'last_time' => end($bars)['time'],
                'first_close' => $change[0],
                'last_close' => end($change),
                'max_drawdown_premium_points' => round($drawdown, 2),
            ],
            'warning' => 'Educational fixed-volatility model Greeks and finite payoff samples, not real IV, OI, exchange quotes, actual trades or comprehensive portfolio risk.',
        ];
    }
}

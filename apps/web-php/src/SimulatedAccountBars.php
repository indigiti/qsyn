<?php
declare(strict_types=1);

namespace QSYN\Accounts;

/**
 * Account-scoped, synthetic visual-only OHLC fixtures.
 *
 * NOT Upstox/OpenAlgo quotes; generated deterministically by selected mock
 * account ID, with source provenance returned in every response.
 */
final class SimulatedAccountBars
{
    public static function make(array $account, ?int $now = null): array
    {
        $id = (string) $account['account_id'];
        $base = 175 + (hexdec(substr(hash('sha256', $id), 0, 6)) % 95);
        $end = intdiv($now ?? time(), 60) * 60;
        $bars = [];
        for ($i = 119; $i >= 0; --$i) {
            $n = 119 - $i;
            $previous = $n - 1;
            $close = round($base + sin($n / 7) * 8 + cos($n / 17) * 4, 2);
            $open = round($base + sin($previous / 7) * 8 + cos($previous / 17) * 4, 2);
            $bars[] = [
                'time' => $end - $i * 60,
                'open' => $open,
                'high' => round(max($open, $close) + 1.4, 2),
                'low' => round(min($open, $close) - 1.4, 2),
                'close' => $close,
                'volume' => 0,
            ];
        }
        return [
            'mode' => 'simulated',
            'source' => 'account-scoped-mock-fixture',
            'symbol' => 'QSYN-MOCK',
            'exchange' => 'QSYN',
            'account_id' => $id,
            'broker_code' => (string) $account['broker_code'],
            'interval' => '1m',
            'bars' => $bars,
            'trading_enabled' => false,
        ];
    }
}

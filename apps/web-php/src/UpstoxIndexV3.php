<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use DateTimeImmutable;
use RuntimeException;

/**
 * Strict Upstox V3 index-candle adapter (data shape only).
 *
 * The public QSYN /india/bars route MUST remain closed. A future authorized
 * account-scoped broker service may use these methods only after verified
 * Upstox OAuth, current BOD instrument keys and NSE/BSE display rights.
 * This class does not read tokens, make network calls or expose market data.
 */
final class UpstoxIndexV3
{
    private const INDEXES = [
        'NSE_INDEX' => ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'INDIAVIX'],
        'BSE_INDEX' => ['SENSEX'],
    ];
    private const INTERVALS = [
        '1m' => ['minutes', '1', 60],
        '5m' => ['minutes', '5', 300],
        '15m' => ['minutes', '15', 900],
        '1h' => ['hours', '1', 3600],
        '1d' => ['days', '1', 86400],
    ];

    /** Exact V3 endpoint path, never a client-supplied URL or instrument key. */
    public static function intradayPath(
        string $exchange, string $symbol, string $instrumentKey, string $interval
    ): string {
        if (!isset(self::INDEXES[$exchange]) || !in_array($symbol, self::INDEXES[$exchange], true)
            || !isset(self::INTERVALS[$interval])
            || strlen($instrumentKey) > 128
            || preg_match('~^' . preg_quote($exchange, '~') . '\\|[A-Za-z0-9 ._-]{1,110}$~D', $instrumentKey) !== 1) {
            throw new RuntimeException('upstox_index_instrument_not_verified');
        }
        [$unit, $step] = self::INTERVALS[$interval];
        return '/v3/historical-candle/intraday/' . rawurlencode($instrumentKey)
            . '/' . $unit . '/' . $step;
    }

    /** Normalize only genuine Upstox V3 OHLCV from its documented candle array. */
    public static function normalize(array $payload, string $interval, int $asofSeconds): array
    {
        if (!isset(self::INTERVALS[$interval])
            || ($payload['status'] ?? null) !== 'success'
            || !is_array($payload['data']['candles'] ?? null)
            || !array_is_list($payload['data']['candles'])
            || count($payload['data']['candles']) > 2000) {
            throw new RuntimeException('invalid_upstox_index_candles');
        }
        $step=self::INTERVALS[$interval][2];
        $rows=[];
        foreach ($payload['data']['candles'] as $item) {
            if (!is_array($item) || !array_is_list($item)
                || count($item) < 6 || count($item) > 7
                || !is_string($item[0])
                || preg_match('/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?\\+05:30$/D', $item[0]) !== 1) {
                throw new RuntimeException('invalid_upstox_index_timestamp');
            }
            try {
                $dt=new DateTimeImmutable($item[0]);
            } catch (\Exception) {
                throw new RuntimeException('invalid_upstox_index_timestamp');
            }
            $t=$dt->getTimestamp();
            // NSE/BSE intraday buckets may start at 09:15 IST rather than a
            // whole UTC hour. Daily bars may start at 00:00 IST, not UTC.
            // Validate the exchange's timezone and minute boundary instead.
            if ($t < 1500000000 || $t > $asofSeconds + $step
                || $t % 60 !== 0
                || ($interval === '1d' && $dt->format('H:i:s') !== '00:00:00')) {
                throw new RuntimeException('invalid_upstox_index_time_alignment');
            }
            $v=[];
            for ($i=1;$i<=5;$i++) {
                $raw=$item[$i];
                if (!(is_int($raw) || is_float($raw) || (is_string($raw) && is_numeric($raw)))) {
                    throw new RuntimeException('invalid_upstox_index_ohlcv');
                }
                $n=(float) $raw;
                if (!is_finite($n) || ($i<5 && $n<=0) || ($i===5 && $n<0)) {
                    throw new RuntimeException('invalid_upstox_index_ohlcv');
                }
                $v[]=$n;
            }
            [$open,$high,$low,$close,$volume]=$v;
            if ($high < max($open,$close) || $low > min($open,$close) || $low > $high) {
                throw new RuntimeException('invalid_upstox_index_ohlcv');
            }
            if (isset($rows[$t])) throw new RuntimeException('duplicate_upstox_index_candle');
            $rows[$t]=compact('open','high','low','close','volume') + ['time'=>$t];
        }
        ksort($rows, SORT_NUMERIC);
        // The first release keeps at most the most recent 300 verified bars.
        return array_values(array_slice($rows,-300,null,true));
    }

    /** Qualified result contract: caller MUST authorize account before use. */
    public static function accountScopedPayload(
        string $account, string $exchange, string $symbol, string $interval,
        array $providerResponse, int $asofSeconds
    ): array {
        if (!preg_match('/^[A-Za-z0-9_.:-]{1,128}$/D',$account)
            || !isset(self::INDEXES[$exchange])
            || !in_array($symbol,self::INDEXES[$exchange],true)) {
            throw new RuntimeException('invalid_upstox_index_account_scope');
        }
        return [
            'schema'=>'QSYN-LICENSED-INDIA-INDEX-BARS/1',
            'source'=>'licensed_broker_index',
            'account_scoped'=>true,
            'account_id'=>$account,
            'exchange'=>$exchange,
            'symbol'=>$symbol,
            'interval'=>$interval,
            'bars'=>self::normalize($providerResponse,$interval,$asofSeconds),
            'asof_ms'=>$asofSeconds*1000,
            'provider'=>'upstox_v3',
            'trading_enabled'=>false,
            'public_redistribution_allowed'=>false,
        ];
    }
}

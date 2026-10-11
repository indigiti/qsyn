<?php
declare(strict_types=1);

namespace QSYN\MarketData;

/**
 * Public metadata only. NSE/BSE INDEX instrument aliases are NOT Upstox
 * instrument keys; an authorized live provider must resolve them from its
 * current instrument master after proving the user's display rights.
 *
 * No broker account token, quote, candle or historical market data is
 * accessible through this unauthenticated phase-1 route.
 */
final class IndiaIndexCatalog
{
    private const INDEXES = [
        'NSE_INDEX' => [
            'NIFTY' => 'NIFTY 50',
            'BANKNIFTY' => 'BANK NIFTY',
            'FINNIFTY' => 'FINNIFTY',
            'MIDCPNIFTY' => 'MIDCPNIFTY',
            'INDIAVIX' => 'INDIA VIX',
        ],
        'BSE_INDEX' => ['SENSEX' => 'SENSEX'],
    ];

    public static function dispatch(string $operation, array $query, array $server): array
    {
        if (($server['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            return [405, ['error' => 'method_not_allowed']];
        }
        if ($operation === 'indexes') {
            $indexes = [];
            foreach (self::INDEXES as $exchange => $symbols) {
                foreach ($symbols as $symbol => $name) {
                    $indexes[] = [
                        'exchange' => $exchange, 'symbol' => $symbol,
                        'name' => $name, 'feed_status' => 'authorization_required',
                    ];
                }
            }
            return [200, [
                'schema' => 'QSYN-INDIA-INDEX-CATALOG/1',
                'source' => 'instrument_discovery_only',
                'indexes' => $indexes,
                'live_data_available' => false,
                'trading_enabled' => false,
                'public_redistribution_allowed' => false,
            ]];
        }

        if ($operation !== 'bars') {
            return [404, ['error' => 'not_found']];
        }
        // Strict hardcoded catalog and timeframes. Never accept arbitrary
        // Upstox instrument keys, arbitrary URLs or user-supplied bearer tokens.
        $exchange = $query['exchange'] ?? null;
        $symbol = $query['symbol'] ?? null;
        $interval = $query['interval'] ?? null;
        $limit = $query['limit'] ?? '300';
        if (!is_string($exchange) || !is_string($symbol)
            || !is_string($interval) || !is_string($limit)
            || !isset(self::INDEXES[$exchange][$symbol])
            || !in_array($interval, ['1m', '5m', '15m', '1h', '1d'], true)
            || !ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 300) {
            return [422, ['error' => 'unsupported_india_index']];
        }

        // Fail closed. Phase 2 must introduce session authentication,
        // entitlement checks, current instrument-master resolution,
        // same-origin licensed history and account-scoped streaming BEFORE
        // replacing this response. OAuth alone is not display authorization.
        return [503, [
            'error' => 'india_index_feed_not_authorized',
            'source' => 'no_licensed_market_data_configured',
            'trading_enabled' => false,
        ]];
    }
}

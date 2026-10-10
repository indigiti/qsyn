<?php
declare(strict_types=1);

namespace QSYN\Broker;

/**
 * Allowlisted, read-only OpenAlgo REST application adapter.
 *
 * Upstream uses POST for reads; this class categorically rejects every
 * order-mutating endpoint, automation toggle, strategy start/stop and
 * settings-write API. All network targets are account-isolated loopback.
 * Returned fields are explicitly sanitized and never include OpenAlgo keys,
 * broker login details or arbitrary untrusted response properties.
 */
final class PrivateOpenAlgoReader
{
    private const SIMPLE = [
        'ping' => 'ping',
        'funds' => 'funds',
        'holdings' => 'holdings',
        'positions' => 'positionbook',
        'orders' => 'orderbook',
        'trades' => 'tradebook',
        'intervals' => 'intervals',
        'analyzer-status' => 'analyzer',
    ];
    private const SYMBOL = [
        'quote' => 'quotes',
        'depth' => 'depth',
        'symbol' => 'symbol',
    ];
    private const OPTIONS = [
        'chain' => 'optionchain',
        'option-greeks' => 'optiongreeks',
    ];

    /** @return list<string> */
    public static function capabilities(): array
    {
        return array_merge(array_keys(self::SIMPLE), array_keys(self::SYMBOL),
            ['history', 'expiry', 'chain', 'search', 'multiquotes']);
    }

    /** @return array<string, mixed> */
    public static function request(array $account, string $operation, array $args = []): array
    {
        if (PHP_SAPI !== 'cli' || getenv('QSYN_PRIVATE_BROKER_GATEWAY') !== '1'
            || getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') {
            throw new \RuntimeException('read_only_gateway_disabled');
        }
        $path = null;
        $body = [];
        if (isset(self::SIMPLE[$operation])) {
            $path = self::SIMPLE[$operation];
            if ($args !== []) {
                throw new \InvalidArgumentException('unsupported_query_arguments');
            }
        } elseif (isset(self::SYMBOL[$operation])) {
            $path = self::SYMBOL[$operation];
            self::keys($args, ['symbol', 'exchange']);
            self::symbol($args['symbol'], $args['exchange']);
            $body = $args;
        } elseif ($operation === 'history') {
            $path = 'history';
            self::keys($args, ['symbol', 'exchange', 'interval', 'start_date', 'end_date']);
            self::symbol($args['symbol'], $args['exchange']);
            if (!in_array($args['interval'], ['1m','3m','5m','10m','15m','30m','1h','D'], true)
                || !self::date($args['start_date']) || !self::date($args['end_date'])
                || $args['start_date'] > $args['end_date']
                || (strtotime($args['end_date']) - strtotime($args['start_date'])) > 31 * 86400) {
                throw new \InvalidArgumentException('invalid_bounded_history_request');
            }
            $body = $args;
        } elseif ($operation === 'expiry') {
            $path = 'expiry';
            self::keys($args, ['symbol', 'exchange', 'instrumenttype']);
            self::symbol($args['symbol'], $args['exchange']);
            if (!in_array($args['instrumenttype'], ['options', 'futures'], true)) {
                throw new \InvalidArgumentException('invalid_expiry_type');
            }
            $body = $args;
        } elseif ($operation === 'chain') {
            $path = 'optionchain';
            self::keys($args, ['underlying', 'exchange', 'expiry_date', 'strike_count']);
            if (!in_array($args['underlying'], ['NIFTY','BANKNIFTY','FINNIFTY','SENSEX'], true)
                || !in_array($args['exchange'], ['NSE_INDEX','BSE_INDEX'], true)
                || !is_string($args['expiry_date'])
                || preg_match('/^[0-3][0-9][A-Z]{3}[0-9]{2}$/D', $args['expiry_date']) !== 1
                || !is_int($args['strike_count'])
                || $args['strike_count'] < 1 || $args['strike_count'] > 15) {
                throw new \InvalidArgumentException('invalid_option_chain_args');
            }
            $body = $args;
        } elseif ($operation === 'search') {
            $path = 'search';
            self::keys($args, ['query', 'exchange']);
            if (!is_string($args['query']) || strlen($args['query']) < 2
                || strlen($args['query']) > 32
                || preg_match('/^[A-Z0-9_.-]+$/D', $args['query']) !== 1
                || !in_array($args['exchange'], ['NSE','BSE','NFO','BFO'], true)) {
                throw new \InvalidArgumentException('invalid_search');
            }
            $body = $args;
        } elseif ($operation === 'multiquotes') {
            $path = 'multiquotes';
            self::keys($args, ['symbols']);
            if (!is_array($args['symbols']) || count($args['symbols']) < 1
                || count($args['symbols']) > 10) {
                throw new \InvalidArgumentException('invalid_multi_symbol_count');
            }
            foreach ($args['symbols'] as $sym) {
                if (!is_array($sym)) {
                    throw new \InvalidArgumentException('invalid_multi_symbol');
                }
                self::keys($sym, ['symbol','exchange']);
                self::symbol($sym['symbol'], $sym['exchange']);
            }
            $body = $args;
        } else {
            // No placeorder, modifyorder, cancelorder, strategy/start,
            // analyzer/toggle, chart-write, messaging bots or credentials.
            throw new \InvalidArgumentException('unsupported_or_mutating_operation');
        }

        $port = $account['rest_port'] ?? null;
        if (!is_int($port) || $port < 1025 || $port > 65535
            || !is_string($account['openalgo_apikey_file'] ?? null)) {
            throw new \InvalidArgumentException('invalid_private_account');
        }
        $key = PrivateBrokerRegistry::credential($account);
        $request = json_encode(['apikey' => $key, ...$body], JSON_THROW_ON_ERROR);
        $url = "http://127.0.0.1:{$port}/api/v1/{$path}";
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\n",
            'content' => $request,
            'timeout' => 3,
            'ignore_errors' => true,
            'follow_location' => 0,
            'max_redirects' => 0,
        ]]);
        $response = @file_get_contents($url, false, $context, 0, 600_001);
        $headers = $http_response_header ?? [];
        $first = is_array($headers) ? ($headers[0] ?? '') : '';
        if (!is_string($response) || strlen($response) > 600_000
            || !preg_match('/^HTTP\/\S+\s+200(?:\s|$)/', (string) $first)) {
            throw new \RuntimeException('isolated_openalgo_session_unavailable');
        }
        try {
            $decoded = json_decode($response, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \RuntimeException('invalid_openalgo_response');
        }
        if (!is_array($decoded) || ($decoded['status'] ?? null) !== 'success') {
            throw new \RuntimeException('openalgo_broker_session_not_authorized');
        }
        return self::sanitize($account, $operation, $decoded);
    }

    private static function keys(array $args, array $allowed): void
    {
        if (array_keys($args) !== $allowed) {
            throw new \InvalidArgumentException('invalid_request_shape');
        }
    }

    private static function symbol(mixed $symbol, mixed $exchange): void
    {
        if (!is_string($symbol) || strlen($symbol) > 100
            || preg_match('/^[A-Z0-9_.-]{1,100}$/D', $symbol) !== 1
            || !in_array($exchange, ['NSE','BSE','NFO','BFO','CDS','MCX','NSE_INDEX','BSE_INDEX'], true)) {
            throw new \InvalidArgumentException('invalid_exchange_or_symbol');
        }
    }
    private static function date(mixed $value): bool
    {
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $value)) {
            return false;
        }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);
        return $date !== false && $date->format('Y-m-d') === $value;
    }

    private static function finite(mixed $value, bool $nonnegative = true): ?float
    {
        if (!(is_int($value) || is_float($value) || (is_string($value)
            && preg_match('/^-?[0-9]+(?:\.[0-9]+)?$/D', $value)))) {
            return null;
        }
        $value = (float) $value;
        if (!is_finite($value) || ($nonnegative && $value < 0)) {
            return null;
        }
        return $value;
    }

    private static function sanitize(array $account, string $op, array $body): array
    {
        $result = [
            'schema' => 'QSYN-PRIVATE-OPENALGO-READ/1',
            'account_id' => $account['account_id'],
            'broker' => $account['broker'],
            'operation' => $op,
            'source' => 'authenticated_openalgo_loopback',
            'received_at_utc' => gmdate('Y-m-d\TH:i:s\Z'),
            'broker_session_responding' => true,
            'market_entitlement_verified' => false,
            'exchange_freshness_verified' => false,
            'public_redistribution_allowed' => false,
            'trading_enabled' => false,
        ];

        if ($op === 'ping') {
            $broker = $body['data']['broker'] ?? null;
            if (!is_string($broker) || $broker !== $account['broker']) {
                throw new \RuntimeException('wrong_broker_for_isolated_instance');
            }
            $result['broker_session_responding'] = true;
        } elseif ($op === 'quote') {
            $price = self::finite($body['data']['ltp'] ?? null);
            if ($price === null || $price <= 0) {
                throw new \RuntimeException('invalid_openalgo_ltp');
            }
            $result['ltp'] = $price;
            $result['timestamp_ms'] = null; // quote REST is not an exchange-time proof
        } elseif ($op === 'history') {
            $rows = $body['data'] ?? null;
            if (!is_array($rows) || count($rows) > 10000) {
                throw new \RuntimeException('oversized_or_missing_history');
            }
            $safe = [];
            foreach ($rows as $bar) {
                if (!is_array($bar) || !is_scalar($bar['timestamp'] ?? null)) {
                    throw new \RuntimeException('invalid_openalgo_history');
                }
                $prices = [];
                foreach (['open','high','low','close'] as $key) {
                    $prices[$key] = self::finite($bar[$key] ?? null);
                    if ($prices[$key] === null) {
                        throw new \RuntimeException('invalid_openalgo_history_price');
                    }
                }
                if ($prices['low'] > min($prices['open'], $prices['close'])
                    || $prices['high'] < max($prices['open'], $prices['close'])) {
                    throw new \RuntimeException('inconsistent_provider_candle');
                }
                $stamp = (string) $bar['timestamp'];
                if (strlen($stamp) > 35 || preg_match('/^[0-9:+ T-]{1,35}$/D', $stamp) !== 1) {
                    throw new \RuntimeException('invalid_history_timestamp');
                }
                $safe[] = ['timestamp' => $stamp, ...$prices,
                    'volume' => self::finite($bar['volume'] ?? 0)];
            }
            $result['bars'] = $safe;
        } elseif ($op === 'chain') {
            $rows = $body['chain'] ?? null;
            if (!is_array($rows) || count($rows) > 40) {
                throw new \RuntimeException('invalid_option_chain');
            }
            $clean = [];
            foreach ($rows as $row) {
                if (!is_array($row) || self::finite($row['strike'] ?? null) === null) {
                    throw new \RuntimeException('invalid_option_strike');
                }
                $leg = ['strike' => (float) $row['strike']];
                foreach (['ce','pe'] as $type) {
                    $contract = $row[$type] ?? null;
                    if (!is_array($contract)) { $leg[$type] = null; continue; }
                    $symbol = $contract['symbol'] ?? null;
                    if (!is_string($symbol)
                        || preg_match('/^[A-Z0-9_.-]{1,100}$/D', $symbol) !== 1) {
                        throw new \RuntimeException('invalid_option_identity');
                    }
                    $leg[$type] = [
                        'symbol' => $symbol,
                        'ltp' => self::finite($contract['ltp'] ?? null),
                        'oi' => self::finite($contract['oi'] ?? null),
                        'implied_volatility' => self::finite($contract['implied_volatility'] ?? null),
                        'delta' => self::finite($contract['delta'] ?? null, false),
                        'gamma' => self::finite($contract['gamma'] ?? null, false),
                        'theta' => self::finite($contract['theta'] ?? null, false),
                        'vega' => self::finite($contract['vega'] ?? null, false),
                    ];
                }
                $clean[] = $leg;
            }
            $result['chain'] = $clean;
        } elseif ($op === 'funds') {
            $data = $body['data'] ?? null;
            if (!is_array($data)) {
                throw new \RuntimeException('invalid_broker_funds');
            }
            $result['funds'] = [];
            foreach (['availablecash','collateral','m2mrealized','m2munrealized','utiliseddebits'] as $key) {
                $result['funds'][$key] = self::finite($data[$key] ?? null, false);
            }
        } elseif (in_array($op, ['holdings','orders','trades','positions','search','multiquotes','expiry'], true)) {
            // Raw books can contain personal identifiers, tokens and
            // nested broker-specific metadata. Local readiness returns
            // presence/count only until a reviewed typed mapping exists.
            $list = $body['data'] ?? $body['results'] ?? [];
            $result['items_count'] = is_array($list) ? count($list) : null;
        } else {
            // Non-enumerated shapes are deliberately not forwarded verbatim.
            $result['upstream_response_valid'] = true;
        }
        return $result;
    }
}

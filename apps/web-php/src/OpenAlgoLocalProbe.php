<?php
declare(strict_types=1);

namespace QSYN\MarketData;

/**
 * Explicitly authorized OPERATOR-CLI-ONLY OpenAlgo loopback probe.
 *
 * No order endpoints, HTTP routes, broker login, browser exposure or automatic
 * activation. Never forward a provider response without sanitizing fields.
 * This is NOT a market feed, entitlement service or production source adapter.
 */
final class OpenAlgoLocalProbe
{
    public static function readPrivateKey(string $path): string
    {
        if ($path === '' || $path[0] !== '/' || is_link($path)) {
            throw new \RuntimeException('private_key_path_required');
        }
        $real = realpath($path);
        if ($real === false || !is_file($real) || is_link($real) || !is_readable($real)) {
            throw new \RuntimeException('private_key_unavailable');
        }
        $perms = fileperms($real);
        if ($perms === false || ($perms & 0077) !== 0) {
            throw new \RuntimeException('private_key_permissions_invalid');
        }
        if (function_exists('posix_geteuid') && fileowner($real) !== posix_geteuid()) {
            throw new \RuntimeException('private_key_owner_invalid');
        }
        if (preg_match('~/(?:public_html|public|webroot|www)/~i', $real)) {
            throw new \RuntimeException('private_key_inside_webroot');
        }
        $raw = file_get_contents($real, false, null, 0, 300);
        if (!is_string($raw)) {
            throw new \RuntimeException('private_key_unavailable');
        }
        $key = trim($raw);
        // Actual provider app keys are opaque. Avoid newlines/control chars.
        if (strlen($key) < 16 || strlen($key) > 256
            || preg_match('/^[A-Za-z0-9_-]+$/D', $key) !== 1) {
            throw new \RuntimeException('private_key_invalid');
        }
        return $key;
    }

    private static function assertSafe(): void
    {
        if (PHP_SAPI !== 'cli' || getenv('QSYN_MARKETDATA_PROBE_ENABLED') !== '1'
            || getenv('QSYN_TRADING_ENABLED') === '1') {
            throw new \RuntimeException('private_marketdata_probe_disabled');
        }
    }

    public static function request(
        string $operation,
        array $args,
        string $keyFile,
        int $port = 5000
    ): array {
        self::assertSafe();
        if ($port < 1025 || $port > 65535) {
            throw new \RuntimeException('invalid_loopback_port');
        }
        $specs = [
            'quote' => ['endpoint' => 'quotes', 'keys' => ['symbol', 'exchange']],
            'chain' => ['endpoint' => 'optionchain', 'keys' =>
                ['underlying', 'exchange', 'expiry_date', 'strike_count']],
        ];
        if (!isset($specs[$operation]) || array_keys($args) !== $specs[$operation]['keys']) {
            throw new \RuntimeException('unsupported_readonly_operation');
        }
        if ($operation === 'quote') {
            if (!is_string($args['symbol']) || strlen($args['symbol']) > 80
                || preg_match('/^[A-Z0-9_-]+$/D', $args['symbol']) !== 1
                || !in_array($args['exchange'], ['NSE', 'NFO', 'BSE', 'BFO'], true)) {
                throw new \RuntimeException('invalid_instrument_request');
            }
        } else {
            if (!in_array($args['underlying'], ['NIFTY', 'BANKNIFTY', 'FINNIFTY'], true)
                || $args['exchange'] !== 'NSE_INDEX'
                || !is_string($args['expiry_date'])
                || preg_match('/^[0-3][0-9][A-Z]{3}[0-9]{2}$/D', $args['expiry_date']) !== 1
                || !is_int($args['strike_count'])
                || $args['strike_count'] < 1 || $args['strike_count'] > 10) {
                throw new \RuntimeException('invalid_option_chain_request');
            }
        }
        $key = self::readPrivateKey($keyFile);
        $request = json_encode(['apikey' => $key, ...$args], JSON_THROW_ON_ERROR);
        // Host fixed to loopback: never connect to a user-provided URL, never
        // follow redirects, never expose API keys via query strings or logs.
        $url = sprintf('http://127.0.0.1:%d/api/v1/%s', $port, $specs[$operation]['endpoint']);
        $context = stream_context_create(['http' => [
            'method' => 'POST', 'header' => "Content-Type: application/json\r\nAccept: application/json\r\n",
            'content' => $request, 'timeout' => 3.0,
            'ignore_errors' => true, 'follow_location' => 0, 'max_redirects' => 0,
        ]]);
        $body = @file_get_contents($url, false, $context, 0, 500000);
        if (!is_string($body) || strlen($body) > 490000) {
            throw new \RuntimeException('local_provider_unreachable_or_oversized');
        }
        $headers = $http_response_header ?? [];
        $first = is_array($headers) ? (string) ($headers[0] ?? '') : '';
        if (!preg_match('/^HTTP\/\S+\s+200(?:\s|$)/', $first)) {
            throw new \RuntimeException('local_provider_http_denied');
        }
        try {
            $payload = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new \RuntimeException('local_provider_invalid_json', 0, $error);
        }
        if (!is_array($payload) || ($payload['status'] ?? null) !== 'success') {
            throw new \RuntimeException('local_provider_not_ready');
        }
        $asof = gmdate('Y-m-d\TH:i:s\Z');
        if ($operation === 'quote') {
            $value = $payload['data']['ltp'] ?? null;
            if (!is_numeric($value) || !is_finite((float) $value) || (float) $value <= 0) {
                throw new \RuntimeException('invalid_openalgo_quote');
            }
            return [
                'schema' => 'QSYN-LOCAL-QUOTE-PROBE/1', 'provider' => 'openalgo',
                'source' => 'operator_loopback_probe', 'instrument' => $args['symbol'],
                'exchange' => $args['exchange'], 'ltp' => (float) $value,
                'receipt_time_utc' => $asof,
                'exchange_timestamp' => null, 'freshness_verified' => false,
                'entitlement_verified' => false, 'trading_enabled' => false,
                'publishable_to_public_studio' => false,
            ];
        }

        $rows = $payload['chain'] ?? null;
        $spot = $payload['underlying_ltp'] ?? null;
        if (!is_array($rows) || count($rows) < 1 || count($rows) > 21
            || !is_numeric($spot) || !is_finite((float) $spot) || (float) $spot <= 0) {
            throw new \RuntimeException('invalid_openalgo_chain');
        }
        $clean = [];
        foreach ($rows as $row) {
            if (!is_array($row) || !is_numeric($row['strike'] ?? null)) {
                throw new \RuntimeException('invalid_openalgo_strike');
            }
            $strike = (float) $row['strike'];
            if (!is_finite($strike) || $strike <= 0) {
                throw new \RuntimeException('invalid_openalgo_strike');
            }
            $contracts = ['strike' => $strike];
            foreach (['ce', 'pe'] as $type) {
                $raw = $row[$type] ?? null;
                if ($raw === null) {
                    $contracts[$type] = null;
                    continue;
                }
                if (!is_array($raw)
                    || !is_string($raw['symbol'] ?? null)
                    || strlen($raw['symbol']) > 80
                    || preg_match('/^[A-Z0-9_-]+$/D', $raw['symbol']) !== 1
                    || !is_numeric($raw['ltp'] ?? null)
                    || !is_finite((float) $raw['ltp']) || (float) $raw['ltp'] <= 0
                    || !is_numeric($raw['lotsize'] ?? null)
                    || (int) $raw['lotsize'] < 1) {
                    throw new \RuntimeException('invalid_openalgo_contract');
                }
                $contracts[$type] = [
                    'symbol' => $raw['symbol'], 'ltp' => (float) $raw['ltp'],
                    'lotsize' => (int) $raw['lotsize'],
                ];
            }
            $clean[] = $contracts;
        }
        return [
            'schema' => 'QSYN-LOCAL-CHAIN-PROBE/1', 'provider' => 'openalgo',
            'source' => 'operator_loopback_probe', 'underlying' => $args['underlying'],
            'expiry_label' => $args['expiry_date'], 'underlying_ltp' => (float) $spot,
            'chain' => $clean, 'receipt_time_utc' => $asof,
            'exchange_timestamp' => null, 'freshness_verified' => false,
            'entitlement_verified' => false, 'trading_enabled' => false,
            'publishable_to_public_studio' => false,
        ];
    }
}

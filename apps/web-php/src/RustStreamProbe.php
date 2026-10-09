<?php
declare(strict_types=1);

namespace QSYN\Diagnostics;

/**
 * A tightly bounded Phase-0 demo-only WebSocket frame probe.
 * PHP connects to a fixed loopback address: no reverse proxy, remote target,
 * command execution, broker credentials or user-selectable requests.
 */
final class RustStreamProbe
{
    private const TARGET = 'tcp://127.0.0.1:10251';
    private const QUOTES = 2;
    private const MAX_FRAME = 4096;

    public static function inspect(): array
    {
        if (!function_exists('stream_socket_client')) {
            return self::result('unavailable');
        }
        $start = hrtime(true);
        $conn = @stream_socket_client(self::TARGET, $errorNumber, $errorMessage, 0.35, STREAM_CLIENT_CONNECT);
        if (!is_resource($conn)) {
            return self::result('offline');
        }
        try {
            // Maximum receive timeout per blocking socket operation.
            stream_set_timeout($conn, 1, 0);
            $key = base64_encode(random_bytes(16));
            $request = "GET /ws/demo HTTP/1.1\r\n"
                . "Host: 127.0.0.1:10251\r\n"
                . "Upgrade: websocket\r\n"
                . "Connection: Upgrade\r\n"
                . "Sec-WebSocket-Key: {$key}\r\n"
                . "Sec-WebSocket-Version: 13\r\n\r\n";
            if (@fwrite($conn, $request) !== strlen($request)) {
                return self::result('connection_failed');
            }
            $first = @fgets($conn, 512);
            if (!is_string($first) || !preg_match('~^HTTP/1\.[01] (\d{3})\b~', $first, $match)) {
                return self::result('unexpected_response');
            }
            $status = (int)$match[1];
            if ($status === 404) {
                return self::result('demo_disabled');
            }
            if ($status !== 101) {
                return self::result('unexpected_response');
            }
            $headers = [];
            $finished = false;
            for ($i = 0; $i < 32; ++$i) {
                $line = @fgets($conn, 1024);
                if (!is_string($line)) {
                    return self::result('handshake_failed');
                }
                if ($line === "\r\n" || $line === "\n") {
                    $finished = true;
                    break;
                }
                $separator = strpos($line, ':');
                if ($separator !== false) {
                    $headers[strtolower(trim(substr($line, 0, $separator)))] = trim(substr($line, $separator + 1));
                }
            }
            $expected = base64_encode(sha1($key . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
            if (!$finished || !hash_equals($expected, (string)($headers['sec-websocket-accept'] ?? ''))) {
                return self::result('handshake_failed');
            }
            $quotes = [];
            for ($i = 0; $i < self::QUOTES; ++$i) {
                $frame = self::readFrame($conn);
                if (!is_string($frame)) {
                    return self::result('frame_invalid');
                }
                $item = json_decode($frame, true);
                if (!is_array($item)
                    || ($item['type'] ?? null) !== 'demo_quote'
                    || ($item['source'] ?? null) !== 'simulated'
                    || ($item['symbol'] ?? null) !== 'QSYN-DEMO'
                    || !is_numeric($item['price'] ?? null)
                    || (float)$item['price'] <= 0
                    || !is_int($item['timestamp'] ?? null)) {
                    return self::result('quote_invalid');
                }
                $quotes[] = [
                    'symbol' => 'QSYN-DEMO',
                    'source' => 'simulated',
                    'price' => (float)$item['price'],
                    'timestamp' => $item['timestamp'],
                ];
            }
            if (count($quotes) !== self::QUOTES) {
                return self::result('frame_invalid');
            }
            return [
                'status' => 'streaming',
                'service' => 'qsyn-stream',
                'websocket' => 'demo_enabled',
                'received' => count($quotes),
                'quotes' => $quotes,
                'latency_ms' => round((hrtime(true) - $start) / 1_000_000, 1),
            ];
        } finally {
            fclose($conn);
        }
    }

    /** Read one bounded, unmasked server-to-client text frame. */
    private static function readFrame($conn): ?string
    {
        $header = self::readExact($conn, 2);
        if ($header === null) {
            return null;
        }
        $first = ord($header[0]);
        $second = ord($header[1]);
        if (($first & 0x80) === 0 || ($first & 0x0f) !== 1 || ($second & 0x80) !== 0) {
            return null;
        }
        $length = $second & 0x7f;
        if ($length === 126) {
            $extended = self::readExact($conn, 2);
            if ($extended === null) {
                return null;
            }
            $length = unpack('n', $extended)[1];
        } elseif ($length === 127) {
            // No demo quote requires 64-bit WebSocket payload lengths.
            return null;
        }
        if ($length === 0 || $length > self::MAX_FRAME) {
            return null;
        }
        return self::readExact($conn, $length);
    }

    private static function readExact($conn, int $length): ?string
    {
        $buffer = '';
        while (strlen($buffer) < $length) {
            $chunk = @fread($conn, $length - strlen($buffer));
            if ($chunk === false || $chunk === '') {
                return null;
            }
            $buffer .= $chunk;
        }
        return $buffer;
    }

    private static function result(string $status): array
    {
        return [
            'status' => $status,
            'service' => 'qsyn-stream',
            'websocket' => $status === 'demo_disabled' ? 'demo_disabled' : 'not_tested',
            'received' => 0,
            'quotes' => [],
        ];
    }
}

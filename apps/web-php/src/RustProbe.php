<?php
declare(strict_types=1);

namespace QSYN\Diagnostics;

/**
 * Read-only, on-demand Phase 0 diagnostic. Probes ONLY localhost:8788.
 * Does not execute processes, accept a target URL, or expose broker secrets.
 */
final class RustProbe
{
    public static function inspect(): array
    {
        $start = hrtime(true);
        $health = self::request('/health');
        $latency = round((hrtime(true) - $start) / 1_000_000, 1);

        if ($health === null) {
            return [
                'status' => 'offline',
                'service' => 'qsyn-stream',
                'http' => 'unreachable',
                'websocket' => 'not_tested',
                'latency_ms' => $latency,
            ];
        }

        $payload = json_decode($health['body'], true);
        if (
            $health['code'] !== 200
            || !is_array($payload)
            || ($payload['status'] ?? null) !== 'ok'
            || ($payload['component'] ?? null) !== 'qsyn-stream'
        ) {
            return [
                'status' => 'unexpected_response',
                'service' => 'qsyn-stream',
                'http' => 'invalid',
                'websocket' => 'not_tested',
                'latency_ms' => $latency,
            ];
        }

        $socket = self::request('/ws/demo', true);
        $websocket = match ($socket['code'] ?? null) {
            101 => 'demo_enabled',
            404 => 'demo_disabled',
            default => 'unavailable',
        };

        return [
            'status' => 'online',
            'service' => 'qsyn-stream',
            'http' => 'healthy',
            'websocket' => $websocket,
            'mode' => (string)($payload['mode'] ?? 'unknown'),
            'upstox_connected' => ($payload['upstox_connected'] ?? null) === true,
            'trading_enabled' => ($payload['trading_enabled'] ?? null) === true,
            'latency_ms' => $latency,
        ];
    }

    /**
     * Single hardcoded target. Max ~0.35s connect + 0.45s receive timeout.
     * Do not add user-selectable hosts/paths: that would create an SSRF surface.
     *
     * @return array{code:int,body:string}|null
     */
    private static function request(string $path, bool $websocket = false): ?array
    {
        if (!function_exists('stream_socket_client')) {
            return null;
        }

        $errno = 0;
        $errstr = '';
        $conn = @stream_socket_client(
            'tcp://127.0.0.1:8788',
            $errno,
            $errstr,
            0.35,
            STREAM_CLIENT_CONNECT
        );
        if ($conn === false) {
            return null;
        }

        try {
            stream_set_timeout($conn, 0, 450_000);
            $headers = "GET {$path} HTTP/1.1\r\n"
                . "Host: 127.0.0.1\r\n";
            if (!$websocket) {
                $headers .= "Connection: close\r\n";
            }
            if ($websocket) {
                $key = base64_encode(random_bytes(16));
                $headers .= "Upgrade: websocket\r\n"
                    . "Connection: Upgrade\r\n"
                    . "Sec-WebSocket-Version: 13\r\n"
                    . "Sec-WebSocket-Key: {$key}\r\n";
            }
            if (@fwrite($conn, $headers . "\r\n") === false) {
                return null;
            }

            $statusLine = @fgets($conn, 512);
            if (!is_string($statusLine) || !preg_match('~^HTTP/1\.[01] ([0-9]{3})~', $statusLine, $matches)) {
                return null;
            }
            $status = (int)$matches[1];
            for ($i = 0; $i < 48; $i++) {
                $line = @fgets($conn, 1024);
                if ($line === false) {
                    return null;
                }
                if (trim($line) === '') {
                    break;
                }
            }
            if ($websocket) {
                return ['code' => $status, 'body' => ''];
            }
            $body = @stream_get_contents($conn, 4096);
            return ['code' => $status, 'body' => is_string($body) ? $body : ''];
        } finally {
            fclose($conn);
        }
    }
}

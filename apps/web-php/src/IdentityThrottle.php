<?php
declare(strict_types=1);

namespace QSYN\Identity;

use RuntimeException;

/**
 * Shared, fixed-window limiter rather than a per-browser session counter.
 * Reserves an attempt before password checking; PHP worker races cannot
 * bypass the threshold. Scope is source IP + tenant + login identifier.
 */
final class IdentityThrottle
{
    public function __construct(private string $privateRoot) {}

    public function reserve(string $remoteIp, string $tenantId, string $username): bool
    {
        $directory = $this->privateRoot . '/identity-throttle';
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new RuntimeException('Cannot create private throttle directory');
        }
        if (is_link($directory)) {
            throw new RuntimeException('Invalid throttle directory');
        }
        $key = hash('sha256', $remoteIp . "\0" . $tenantId . "\0" . $username);
        $path = $directory . '/' . $key . '.json';
        $handle = fopen($path, 'c+');
        if ($handle === false) {
            throw new RuntimeException('Cannot open login throttle');
        }
        try {
            chmod($path, 0600);
            if (!flock($handle, LOCK_EX)) {
                throw new RuntimeException('Cannot lock login throttle');
            }
            rewind($handle);
            $row = json_decode(stream_get_contents($handle) ?: '{}', true);
            $now = time();
            $start = is_array($row) ? (int) ($row['started'] ?? 0) : 0;
            $count = is_array($row) ? (int) ($row['count'] ?? 0) : 0;
            if ($start > $now || $start <= $now - 900) {
                $start = $now;
                $count = 0;
            }
            $allowed = $count < 5;
            if ($allowed) {
                $count++;
                rewind($handle);
                if (!ftruncate($handle, 0)
                    || fwrite($handle, json_encode(['started' => $start, 'count' => $count], JSON_THROW_ON_ERROR)) === false
                    || !fflush($handle)) {
                    throw new RuntimeException('Cannot update login throttle');
                }
            }
            return $allowed;
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
}

<?php
declare(strict_types=1);

namespace QSYN\Storage;

use InvalidArgumentException;
use RuntimeException;

/**
 * Development-only file repository. Not approved for real broker credentials,
 * payment data or live trading. No MariaDB/Redis dependency.
 */
final class FileStore
{
    private string $root;

    public function __construct(string $root)
    {
        if ($root === '' || is_link($root)) {
            throw new InvalidArgumentException('Storage directory is required');
        }
        if (!is_dir($root) && !mkdir($root, 0700, true) && !is_dir($root)) {
            throw new RuntimeException('Cannot create storage root');
        }
        $real = realpath($root);
        if ($real === false) {
            throw new RuntimeException('Cannot resolve storage root');
        }
        clearstatcache(true, $real);
        $mode = fileperms($real);
        if ($mode === false || ($mode & 0007) !== 0 || ($mode & 0020) !== 0) {
            throw new RuntimeException('Unsafe private storage permissions');
        }
        $this->root = $real;
    }

    public function rootPath(): string
    {
        return $this->root;
    }

    private function path(string $collection, string $id): string
    {
        if (!preg_match('/^[a-z][a-z0-9_-]{0,47}$/', $collection) ||
            !preg_match('/^[a-zA-Z0-9_-]{1,96}$/', $id)) {
            throw new InvalidArgumentException('Unsafe collection or record identifier');
        }
        $dir = $this->root . '/' . $collection;
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Cannot create collection');
        }
        if (is_link($dir)) {
            throw new RuntimeException('Collection symlink not allowed');
        }
        clearstatcache(true, $dir);
        $mode = fileperms($dir);
        if ($mode === false || ($mode & 0007) !== 0 || ($mode & 0020) !== 0) {
            throw new RuntimeException('Unsafe collection permissions');
        }
        return $dir . '/' . $id . '.json';
    }

    public function get(string $collection, string $id): ?array
    {
        $path = $this->path($collection, $id);
        if (is_link($path)) {
            throw new RuntimeException('Record symlink not allowed');
        }
        if (!is_file($path)) {
            return null;
        }
        clearstatcache(true, $path);
        $mode = fileperms($path);
        if ($mode === false || ($mode & 0077) !== 0) {
            throw new RuntimeException('Unsafe private record permissions');
        }
        $bytes = file_get_contents($path);
        if ($bytes === false) {
            throw new RuntimeException('Cannot read record');
        }
        $record = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($record) || !isset($record['revision'])) {
            throw new RuntimeException('Corrupt file-backed record');
        }
        return $record;
    }

    /**
     * Enumerate low-volume development records. Account ownership and tenant
     * checks belong to the repository using this primitive, not to callers.
     * Never use this scan for tick/candle market data.
     *
     * @return list<array<string, mixed>>
     */
    public function listRecords(string $collection): array
    {
        $dir = dirname($this->path($collection, '__probe__'));
        $names = scandir($dir);
        if ($names === false) {
            throw new RuntimeException('Cannot enumerate collection');
        }
        $records = [];
        foreach ($names as $name) {
            if (!preg_match('/^([a-zA-Z0-9_-]{1,96})\\.json$/', $name, $match)) {
                continue;
            }
            $path = $dir . '/' . $name;
            if (is_link($path)) {
                throw new RuntimeException('Symlink records are not allowed');
            }
            $record = $this->get($collection, $match[1]);
            if ($record !== null) {
                $records[] = $record;
            }
        }
        return $records;
    }

    /**
     * Optimistic concurrency: revision starts at 1.
     * null expectedRevision is allowed only for a new record.
     */
    public function put(string $collection, string $id, array $data, ?int $expectedRevision = null): array
    {
        $path = $this->path($collection, $id);
        if (is_link($path . '.lock') || is_link($path)) {
            throw new RuntimeException('Record lock or file symlink not allowed');
        }
        $lock = fopen($path . '.lock', 'c');
        if ($lock === false) {
            throw new RuntimeException('Cannot open record lock');
        }
        chmod($path . '.lock', 0600);
        $tmp = null;
        try {
            if (!flock($lock, LOCK_EX)) {
                throw new RuntimeException('Cannot lock record');
            }
            $current = $this->get($collection, $id);
            $revision = (int) ($current['revision'] ?? 0);
            if ($revision === 0 && $expectedRevision !== null && $expectedRevision !== 0) {
                throw new RuntimeException('Revision conflict');
            }
            if ($revision > 0 && $expectedRevision !== $revision) {
                throw new RuntimeException('Revision conflict');
            }
            $record = [
                'schema_version' => 1,
                'id' => $id,
                'revision' => $revision + 1,
                'updated_at' => gmdate('c'),
                'data' => $data,
            ];
            $json = json_encode($record, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            $tmp = tempnam(dirname($path), '.pending-');
            if ($tmp === false) {
                throw new RuntimeException('Cannot create pending record');
            }
            chmod($tmp, 0600);
            $handle = fopen($tmp, 'wb');
            if ($handle === false) {
                throw new RuntimeException('Cannot open pending record');
            }
            try {
                $n = fwrite($handle, $json);
                if ($n !== strlen($json) || !fflush($handle)) {
                    throw new RuntimeException('Cannot persist pending record');
                }
                if (function_exists('fsync') && !fsync($handle)) {
                    throw new RuntimeException('Cannot sync pending record');
                }
            } finally {
                fclose($handle);
            }
            if (!rename($tmp, $path)) {
                throw new RuntimeException('Cannot publish record');
            }
            $tmp = null;
            return $record;
        } finally {
            if ($tmp !== null && is_file($tmp)) {
                unlink($tmp);
            }
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

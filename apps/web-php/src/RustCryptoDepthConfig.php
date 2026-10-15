<?php
declare(strict_types=1);

namespace QSYN\Admin;

use QSYN\Diagnostics\RustProbe;

/**
 * Authenticated operations-only control of the existing Rust depth gate.
 * A private 0600 runtime flag is applied on each REST request by Rust.
 * The flag never contains credentials and never starts/stops a process.
 */
final class RustCryptoDepthConfig
{
    private static function flagFile(): ?string
    {
        $root = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2) . '/runtime');
        if (!str_starts_with($root, '/') || preg_match('~(?:^|/)\.\.(?:/|$)~', $root)
            || !is_dir($root) || is_link($root) || !is_writable($root)) {
            return null;
        }
        clearstatcache(true, $root);
        $mode = @fileperms($root);
        if ($mode === false || ($mode & 0002) !== 0) {
            return null;
        }
        $flag = rtrim($root, '/') . '/crypto-depth.flag';
        clearstatcache(true, $flag);
        if (is_link($flag) || (file_exists($flag) && !is_file($flag))) {
            return null;
        }
        return $flag;
    }

    public static function state(): array
    {
        $health = RustProbe::inspect();
        $online = ($health['status'] ?? null) === 'online';
        $supported = $online && ($health['crypto_depth_runtime_control'] ?? false) === true;
        return [
            'manager' => 'private_runtime_flag',
            'engine_online' => $online,
            'supported' => $supported,
            'writable' => self::flagFile() !== null,
            'enabled' => $supported ? (($health['crypto_depth_enabled'] ?? false) === true) : null,
            'restart_required' => false,
            'trading_enabled' => false,
        ];
    }

    public static function change(bool $enabled): array
    {
        $before = self::state();
        if (!$before['engine_online'] || !$before['supported']) {
            return ['ok' => false, 'error' => 'runtime_upgrade_required'];
        }
        $flag = self::flagFile();
        if ($flag === null) {
            return ['ok' => false, 'error' => 'private_runtime_not_writable'];
        }
        // A temporary sibling plus atomic rename ensures Rust sees only 0/1
        // with no incomplete writes. Reject target symlinks explicitly.
        $tmp = dirname($flag) . '/.crypto-depth-' . bin2hex(random_bytes(8));
        try {
            if (@file_put_contents($tmp, $enabled ? "1\n" : "0\n", LOCK_EX) === false
                || !@chmod($tmp, 0600)
                || is_link($flag)
                || (file_exists($flag) && !is_file($flag))
                || !@rename($tmp, $flag)) {
                return ['ok' => false, 'error' => 'private_runtime_write_failed'];
            }
        } finally {
            if (is_file($tmp)) {
                @unlink($tmp);
            }
        }
        $after = self::state();
        if (!$after['supported'] || $after['enabled'] !== $enabled) {
            return ['ok' => false, 'error' => 'runtime_toggle_not_applied'];
        }
        return [
            'ok' => true,
            'enabled' => $enabled,
            'message' => 'crypto_depth_updated',
            'restart_required' => false,
        ];
    }
}

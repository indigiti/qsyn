<?php
declare(strict_types=1);

namespace QSYN\Admin;

use QSYN\Diagnostics\RustProbe;

/**
 * Tiny Phase-0 demo-only toggle. No executable, PID, target or command control.
 * Configuration lives in the persistent private Rust runtime directory.
 */
final class RustDemoConfig
{
    private static function runtimeDir(): ?string
    {
        $root = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2) . '/runtime');
        if (!str_starts_with($root, '/') || str_contains($root, '/../') || str_ends_with($root, '/..')) {
            return null;
        }
        // An existing directory is expected for a running Rust daemon.
        if (!is_dir($root) || is_link($root) || !is_writable($root)) {
            return null;
        }
        return rtrim($root, '/');
    }

    private static function flagFile(): ?string
    {
        $root = self::runtimeDir();
        if ($root === null) {
            return null;
        }
        $flag = $root . '/demo-websocket.flag';
        if (is_link($flag) || (file_exists($flag) && !is_file($flag))) {
            return null;
        }
        return $flag;
    }

    public static function state(): array
    {
        $health = RustProbe::inspect();
        return [
            'manager' => 'private_runtime_flag',
            'writable' => self::flagFile() !== null,
            'engine_online' => ($health['status'] ?? '') === 'online',
            'supported' => ($health['demo_runtime_control'] ?? false) === true,
            'enabled' => ($health['demo_runtime_control'] ?? false) === true
                ? (($health['demo_ws_enabled'] ?? false) === true)
                : null,
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
        // Use a randomized temporary sibling file; never write through a
        // possibly symlinked target or release-managed application asset.
        $tmp = dirname($flag) . '/.demo-websocket-' . bin2hex(random_bytes(8));
        try {
            if (@file_put_contents($tmp, $enabled ? "1\n" : "0\n", LOCK_EX) === false
                || !@chmod($tmp, 0600)
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
        return ['ok' => true, 'enabled' => $enabled, 'message' => 'demo_websocket_updated'];
    }
}

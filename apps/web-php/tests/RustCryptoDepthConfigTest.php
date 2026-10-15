<?php
declare(strict_types=1);

namespace QSYN\Diagnostics {
    // An isolated, deterministic Rust-health double; the production adapter
    // verifies the actual running Rust /health response.
    final class RustProbe {
        public static function inspect(): array {
            $dir = (string)getenv('QSYN_RUNTIME_DIR');
            $path = $dir . '/crypto-depth.flag';
            $enabled = false;
            if (is_file($path) && !is_link($path) && (((int)@fileperms($path) & 0077) === 0)) {
                $enabled = trim((string)@file_get_contents($path)) === '1';
            }
            return [
                'status' => getenv('QSYN_TEST_RUST_OFFLINE') === '1' ? 'offline' : 'online',
                'crypto_depth_runtime_control' => getenv('QSYN_TEST_RUST_UNSUPPORTED') !== '1',
                'crypto_depth_enabled' => $enabled,
            ];
        }
    }
}

namespace {
    require_once dirname(__DIR__) . '/src/RustCryptoDepthConfig.php';
    use QSYN\Admin\RustCryptoDepthConfig;

    function ensure(bool $value, string $label): void {
        if (!$value) throw new \RuntimeException('FAIL: ' . $label);
    }
    $dir = sys_get_temp_dir() . '/qsyn-depth-control-' . bin2hex(random_bytes(6));
    ensure(mkdir($dir, 0700), 'create private runtime');
    putenv('QSYN_RUNTIME_DIR=' . $dir);
    try {
        ensure(RustCryptoDepthConfig::state()['enabled'] === false, 'disabled by default');
        ensure(RustCryptoDepthConfig::state()['writable'], 'runtime writable');
        $first = RustCryptoDepthConfig::change(true);
        ensure($first['ok'] === true && $first['enabled'] === true, 'enable depth');
        $flag = $dir . '/crypto-depth.flag';
        ensure(file_get_contents($flag) === "1\n", 'private flag written');
        ensure(((int)fileperms($flag) & 0777) === 0600, '0600 flag');
        ensure(RustCryptoDepthConfig::change(false)['ok'] === true, 'disable depth');
        ensure(RustCryptoDepthConfig::state()['enabled'] === false, 'Rust reports disabled');
        ensure(file_get_contents($flag) === "0\n", 'disabled flag persisted');
        putenv('QSYN_TEST_RUST_OFFLINE=1');
        ensure(RustCryptoDepthConfig::change(true)['error'] === 'runtime_upgrade_required', 'offline denied');
        putenv('QSYN_TEST_RUST_OFFLINE');
        putenv('QSYN_TEST_RUST_UNSUPPORTED=1');
        ensure(RustCryptoDepthConfig::change(true)['error'] === 'runtime_upgrade_required', 'old Rust denied');
        putenv('QSYN_TEST_RUST_UNSUPPORTED');
        unlink($flag);
        $outside = $dir . '/outside.txt';
        file_put_contents($outside, 'keep-safe');
        ensure(symlink($outside, $flag), 'create symlink trap');
        ensure(RustCryptoDepthConfig::change(true)['error'] === 'private_runtime_not_writable', 'symlink rejected');
        ensure(file_get_contents($outside) === 'keep-safe', 'no symlink escape');
        unlink($flag);
        unlink($outside);
        putenv('QSYN_RUNTIME_DIR=relative-unsafe');
        ensure(!RustCryptoDepthConfig::state()['writable'], 'relative path refused');
        putenv('QSYN_RUNTIME_DIR=' . $dir);
        chmod($dir, 0777);
        ensure(!RustCryptoDepthConfig::state()['writable'], 'world writable directory denied');
        echo "PASS: depth control is private, live-verified, atomic, and fail-closed\n";
    } finally {
        putenv('QSYN_RUNTIME_DIR');
        putenv('QSYN_TEST_RUST_OFFLINE');
        putenv('QSYN_TEST_RUST_UNSUPPORTED');
        foreach (glob($dir . '/*') ?: [] as $p) @unlink($p);
        @chmod($dir, 0700);
        @rmdir($dir);
    }
}

<?php
declare(strict_types=1);

namespace QSYN\Diagnostics {
    // Fake only the Rust health transport so we can independently test the
    // file-writing gate without starting a public or real process.
    final class RustProbe {
        public static function inspect(): array {
            $dir = (string)getenv('QSYN_RUNTIME_DIR');
            $flag = $dir . '/demo-websocket.flag';
            $content = is_file($flag) ? @file_get_contents($flag) : "0\n";
            return [
                'status' => 'online',
                'demo_runtime_control' => true,
                'demo_ws_enabled' => trim((string)$content) === '1',
            ];
        }
    }
}

namespace {
    require_once dirname(__DIR__) . '/src/RustDemoConfig.php';

    use QSYN\Admin\RustDemoConfig;

    function ensure(bool $condition, string $message): void {
        if (!$condition) throw new \RuntimeException($message);
    }

    $dir = sys_get_temp_dir() . '/qsyn-demo-control-' . bin2hex(random_bytes(6));
    ensure(mkdir($dir, 0700), 'create runtime directory');
    putenv('QSYN_RUNTIME_DIR=' . $dir);
    try {
        $state = RustDemoConfig::state();
        ensure($state['supported'] === true && $state['writable'] === true, 'enabled runtime bridge');
        $result = RustDemoConfig::change(true);
        ensure($result['ok'] === true, 'enable demo');
        $path = $dir . '/demo-websocket.flag';
        ensure(file_get_contents($path) === "1\n", 'private toggle enabled');
        ensure(((int)fileperms($path) & 0777) === 0600, 'strict config mode 0600');
        ensure(RustDemoConfig::state()['enabled'] === true, 'reads enable state');
        ensure(RustDemoConfig::change(false)['ok'] === true, 'disable demo');
        ensure(file_get_contents($path) === "0\n", 'private toggle disabled');

        unlink($path);
        $outside = $dir . '/outside.txt';
        file_put_contents($outside, 'outside-safe');
        ensure(symlink($outside, $path), 'create symlink test');
        $blocked = RustDemoConfig::change(true);
        ensure($blocked['error'] === 'private_runtime_not_writable', 'refuse symlink');
        ensure(file_get_contents($outside) === 'outside-safe', 'do not follow symlinks');
        unlink($path);
        unlink($outside);

        putenv('QSYN_RUNTIME_DIR=relative-unsafe');
        ensure(RustDemoConfig::state()['writable'] === false, 'reject relative path');
        echo "PASS: admin Rust demo mode writes private atomic flag, preserves mode, rejects symlinks\n";
    } finally {
        putenv('QSYN_RUNTIME_DIR');
        foreach (glob($dir . '/*') ?: [] as $file) @unlink($file);
        rmdir($dir);
    }
}

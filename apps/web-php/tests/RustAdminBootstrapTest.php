<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/RustAdmin.php';
require_once dirname(__DIR__) . '/src/RustAdminBootstrap.php';

use QSYN\Admin\RustAdmin;
use QSYN\Admin\RustAdminBootstrap;

function checkBootstrap(bool $value, string $description): void
{
    if (!$value) throw new RuntimeException('FAIL: ' . $description);
}

$runtime = sys_get_temp_dir() . '/qsyn-bootstrap-' . bin2hex(random_bytes(6));
checkBootstrap(mkdir($runtime, 0700), 'create private runtime');
putenv('QSYN_RUNTIME_DIR=' . $runtime);
putenv('QSYN_ADMIN_PASSWORD_HASH');
putenv('QSYN_CONTROL_ENABLED');
$_SESSION = [];
$codeFile = $runtime . '/admin-setup-code.txt';
$authFile = $runtime . '/admin-auth.json';
$lockFile = $runtime . '/.admin-setup.lock';
try {
    checkBootstrap(!RustAdmin::configured(), 'fresh install starts without administrator');
    $ready = RustAdminBootstrap::status();
    checkBootstrap($ready['available'] === true, 'first-run pairing code generated');
    checkBootstrap(!array_key_exists('code', $ready), 'status never leaks pairing code');
    $code = trim((string)file_get_contents($codeFile));
    checkBootstrap((bool)preg_match('/^[a-f0-9]{64}$/D', $code), 'high entropy pairing code');
    checkBootstrap(((int)fileperms($codeFile) & 0777) === 0600, 'private code has owner-only mode');
    checkBootstrap(((int)fileperms($lockFile) & 0777) === 0600, 'private lock has owner-only mode');
    checkBootstrap(trim((string)file_get_contents($codeFile)) === $code, 'code persists between status calls');
    checkBootstrap(strlen(RustAdminBootstrap::csrf()) === 64, 'CSRF issued only for setup');
    checkBootstrap(!RustAdminBootstrap::validCsrf('wrong'), 'invalid CSRF rejected');
    checkBootstrap(RustAdminBootstrap::validCsrf(RustAdminBootstrap::csrf()), 'valid CSRF accepted');
    $password = 'long-private-test-password-' . bin2hex(random_bytes(12));
    checkBootstrap(!RustAdminBootstrap::complete(str_repeat('f', 64), $password)['ok'], 'wrong pairing code rejected');
    checkBootstrap(!RustAdminBootstrap::complete($code, 'short-password')['ok'], 'weak password rejected');
    checkBootstrap(RustAdminBootstrap::complete($code, $password)['ok'] === true, 'pairing code creates administrator');
    checkBootstrap(RustAdmin::configured(), 'normal administrator now configured');
    checkBootstrap(((int)fileperms($authFile) & 0777) === 0600, 'admin hash file remains 0600');
    checkBootstrap(!file_exists($codeFile), 'pairing code consumed');
    checkBootstrap(!RustAdminBootstrap::status()['available'], 'setup permanently disabled after registration');
    checkBootstrap(!RustAdminBootstrap::complete($code, 'another-test-password-' . bin2hex(random_bytes(12)))['ok'], 'replay rejected');
    $json = json_decode((string)file_get_contents($authFile), true, 512, JSON_THROW_ON_ERROR);
    checkBootstrap(password_verify($password, $json['password_hash']), 'password saved only as hash');
    checkBootstrap(RustAdmin::attempt($password), 'normal administrator login works after setup');
    RustAdmin::logout();

    // Existing malformed config must prevent reinitialization and takeover.
    unlink($authFile);
    file_put_contents($authFile, '{invalid');
    chmod($authFile, 0600);
    checkBootstrap(!RustAdminBootstrap::status()['available'], 'corrupt existing admin cannot be replaced by bootstrap');
    unlink($authFile);
    checkBootstrap(RustAdminBootstrap::status()['available'], 'fresh setup permitted only when truly unconfigured');
    checkBootstrap(chmod($codeFile, 0644), 'insecure code file fixture');
    checkBootstrap(!RustAdminBootstrap::status()['available'], 'world-readable pairing code rejected');
    unlink($codeFile);
    putenv('QSYN_CONTROL_ENABLED=0');
    checkBootstrap(!RustAdminBootstrap::status()['available'], 'environment kill switch disables setup');
    putenv('QSYN_CONTROL_ENABLED');
    file_put_contents($authFile, 'disabled');
    chmod($authFile, 0600);
    checkBootstrap(!RustAdminBootstrap::status()['available'], 'existing invalid admin file remains fail-closed');

    echo "PASS: private web bootstrap code, password strength, ownership, CSRF, replay and fail-closed gates\n";
} finally {
    putenv('QSYN_RUNTIME_DIR');
    putenv('QSYN_CONTROL_ENABLED');
    foreach (glob($runtime . '/{*,.*}', GLOB_BRACE) ?: [] as $item) {
        if (in_array(basename($item), ['.', '..'], true)) continue;
        if (is_file($item) || is_link($item)) @unlink($item);
    }
    @rmdir($runtime);
}

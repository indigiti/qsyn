<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/RustAdmin.php';
require_once dirname(__DIR__) . '/src/RustSupervisor.php';

use QSYN\Admin\RustAdmin;
use QSYN\Admin\RustSupervisor;

function ensure(bool $condition, string $label): void
{
    if (!$condition) throw new RuntimeException("FAIL: " . $label);
}

putenv('QSYN_CONTROL_ENABLED');
putenv('QSYN_ADMIN_PASSWORD_HASH');
ensure(!RustAdmin::configured(), 'admin fails closed without server configuration');
ensure(!RustSupervisor::available(), 'supervisor fails closed');
ensure(RustSupervisor::execute('start')['error'] === 'service_manager_unavailable', 'start unavailable');
ensure(RustSupervisor::execute('rm -rf /')['error'] === 'invalid_action', 'arbitrary command rejected');
ensure(RustSupervisor::execute('qsyn-stream')['error'] === 'invalid_action', 'program name not accepted as action');

$password = 'test-password-strong-' . bin2hex(random_bytes(10));
$hash = password_hash($password, PASSWORD_DEFAULT);
putenv('QSYN_ADMIN_PASSWORD_HASH=' . $hash);
putenv('QSYN_CONTROL_ENABLED=1');
putenv('QSYN_ALLOW_HTTP_TEST=1');
ensure(RustAdmin::configured(), 'configured with valid password hash');
ensure(RustAdmin::originAllowed(['HTTP_HOST'=>'localhost']), 'CI-only HTTPS override permitted');
ensure(RustAdmin::originAllowed(['HTTP_HOST'=>'127.0.0.1:18080','HTTP_ORIGIN'=>'http://127.0.0.1:18080']), 'matching loopback HTTP browser origin allowed for CI');
ensure(!RustAdmin::originAllowed(['HTTP_HOST'=>'stage.digiti.in','HTTP_ORIGIN'=>'http://stage.digiti.in']), 'test flag cannot permit public HTTP origin');
ensure(!RustAdmin::originAllowed(['HTTP_HOST'=>'localhost','HTTP_SEC_FETCH_SITE'=>'cross-site']), 'cross-site blocked');
ensure(!RustAdmin::originAllowed(['HTTP_HOST'=>'localhost','HTTP_ORIGIN'=>'https://evil.example']), 'foreign origin blocked');

RustAdmin::boot();
ensure(!RustAdmin::attempt('wrong-password'), 'invalid password rejected');
ensure(!RustAdmin::authenticated(), 'invalid login unauthenticated');
ensure(!RustAdmin::attempt(''), 'empty password rejected');
ensure(RustAdmin::attempt($password), 'correct password accepted');
ensure(RustAdmin::authenticated(), 'valid login authenticated');
ensure(strlen(RustAdmin::csrf()) === 64, 'CSRF generated for valid admin');
ensure(!RustAdmin::verifyCsrf('fake-token'), 'invalid CSRF rejected');
ensure(RustAdmin::verifyCsrf(RustAdmin::csrf()), 'valid CSRF accepted');
ensure(RustSupervisor::status()['state'] === 'unavailable', 'no supervisor without approved config');
putenv('QSYN_SERVICE_MANAGER=direct');
ensure(!RustSupervisor::available(), 'direct control fails closed without deployed executable');
ensure(RustSupervisor::execute('start')['error'] === 'service_manager_unavailable', 'direct start disabled without binary');
putenv('QSYN_SERVICE_MANAGER');
RustAdmin::logout();
ensure(!RustAdmin::authenticated(), 'logout revokes session');
ensure(!RustAdmin::verifyCsrf(RustAdmin::csrf()), 'logout invalidates CSRF');

// Cloudways must not need PHP-FPM environment changes just to enable
// authenticated QSYN demo-stream toggles. The persistent private 0600 file
// is a valid alternative, but world-readable files and symlinks fail closed.
$root = sys_get_temp_dir() . '/qsyn-private-admin-' . bin2hex(random_bytes(6));
ensure(mkdir($root, 0700), 'private runtime directory created');
putenv('QSYN_RUNTIME_DIR=' . $root);
putenv('QSYN_CONTROL_ENABLED');
putenv('QSYN_ADMIN_PASSWORD_HASH');
$config = $root . '/admin-auth.json';
try {
    ensure(!RustAdmin::configured(), 'no private file fails closed');
    $content = json_encode([
        'schema' => 'QSYN-ADMIN/1',
        'enabled' => true,
        'password_hash' => $hash,
    ], JSON_THROW_ON_ERROR) . "\n";
    ensure(file_put_contents($config, $content) !== false, 'private config written');
    ensure(chmod($config, 0600), 'private config locked down');
    ensure(RustAdmin::configured(), 'private config activates admin without PHP-FPM env');
    ensure(RustAdmin::attempt($password), 'private config password accepted');
    ensure(RustAdmin::authenticated(), 'private-config session authenticated');
    RustAdmin::logout();
    ensure(chmod($config, 0644), 'insecure file fixture');
    ensure(!RustAdmin::configured(), 'world-readable config denied');
    ensure(chmod($config, 0600), 'restore private file mode');
    ensure(file_put_contents($config, '{broken-json') !== false, 'malformed fixture');
    ensure(!RustAdmin::configured(), 'malformed admin file denied');
    unlink($config);
    ensure(symlink('/etc/passwd', $config), 'symlink fixture');
    ensure(!RustAdmin::configured(), 'symlink admin config denied');
    unlink($config);
    ensure(file_put_contents($config, $content) !== false, 'restore private config');
    ensure(chmod($config, 0600), 'restore strict mode');
    putenv('QSYN_CONTROL_ENABLED=0');
    ensure(!RustAdmin::configured(), 'explicit kill switch overrides private config');
    putenv('QSYN_CONTROL_ENABLED');
    ensure(RustAdmin::configured(), 'private config recovers when kill switch unset');
    ensure(file_put_contents($config, json_encode([
        'schema' => 'QSYN-ADMIN/1', 'enabled' => false, 'password_hash' => $hash,
    ], JSON_THROW_ON_ERROR)) !== false, 'disabled fixture');
    ensure(!RustAdmin::configured(), 'explicit disabled config denied');
} finally {
    putenv('QSYN_RUNTIME_DIR');
    putenv('QSYN_CONTROL_ENABLED');
    putenv('QSYN_ADMIN_PASSWORD_HASH');
    if (file_exists($config) || is_link($config)) unlink($config);
    rmdir($root);
}
echo "PASS: Rust admin session, private 0600 file activation, and fail-closed safety gates\n";

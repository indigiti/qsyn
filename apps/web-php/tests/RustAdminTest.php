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
RustAdmin::logout();
ensure(!RustAdmin::authenticated(), 'logout revokes session');
ensure(!RustAdmin::verifyCsrf(RustAdmin::csrf()), 'logout invalidates CSRF');
echo "PASS: Rust service controls fail closed, authenticate, verify CSRF, and restrict actions\n";

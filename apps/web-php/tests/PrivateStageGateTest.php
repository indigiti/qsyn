<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/FileStore.php';
require_once dirname(__DIR__) . '/src/UserRepository.php';
require_once dirname(__DIR__) . '/src/FileUserRepository.php';
require_once dirname(__DIR__) . '/src/UserSession.php';
require_once dirname(__DIR__) . '/src/IdentityApi.php';

use QSYN\Identity\IdentityApi;
use QSYN\Identity\UserSession;

function gateCheck(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}
$original = $_SERVER;
$root = sys_get_temp_dir() . '/qsyn-stage-gate-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
try {
    putenv('QSYN_IDENTITY_ENABLED=1');
    putenv('QSYN_IDENTITY_STORAGE_DIR=' . $root);
    putenv('QSYN_ENV=development');
    putenv('QSYN_IDENTITY_ALLOWED_HOST=private-qsyn.example.test');
    putenv('QSYN_PRIVATE_STAGING_CONFIRMED=1');
    $_SERVER['HTTP_HOST'] = 'private-qsyn.example.test';
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = '443';
    gateCheck(IdentityApi::privateRoot() === realpath($root),
        'Explicit HTTPS private test host should pass development gate');
    $_SERVER['HTTP_HOST'] = 'stage.digiti.in';
    gateCheck(IdentityApi::privateRoot() === null,
        'Public staging host accepted under different private ingress allowance');
    $_SERVER['HTTP_HOST'] = 'private-qsyn.example.test';
    $_SERVER['HTTPS'] = 'off';
    $_SERVER['SERVER_PORT'] = '80';
    gateCheck(IdentityApi::privateRoot() === null, 'Insecure development HTTP permitted');
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = '443';
    putenv('QSYN_PRIVATE_STAGING_CONFIRMED=0');
    gateCheck(IdentityApi::privateRoot() === null, 'Missing private staging assertion accepted');
    putenv('QSYN_PRIVATE_STAGING_CONFIRMED=1');
    chmod($root, 0770);
    gateCheck(IdentityApi::privateRoot() === null, 'Group-writeable private root accepted');
    chmod($root, 0700);

    putenv('QSYN_ENV=test');
    putenv('QSYN_ALLOW_HTTP_TEST=1');
    $_SERVER['HTTP_HOST'] = '127.0.0.1:18080';
    $_SERVER['HTTPS'] = 'off';
    $_SERVER['SERVER_PORT'] = '18080';
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    $_SERVER['SERVER_ADDR'] = '127.0.0.1';
    gateCheck(IdentityApi::privateRoot() === realpath($root),
        'True loopback should allow disposable test mode');
    $_SERVER['REMOTE_ADDR'] = '198.51.100.42';
    gateCheck(IdentityApi::privateRoot() === null, 'Spoofed localhost header accepted externally');
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    $_SERVER['SERVER_ADDR'] = '198.51.100.42';
    gateCheck(!UserSession::loopbackTest($_SERVER),
        'Public listener accepted test-only insecure sessions');
    $_SERVER['SERVER_ADDR'] = '127.0.0.1';

    putenv('QSYN_IDENTITY_ENABLED=0');
    gateCheck(IdentityApi::privateRoot() === null, 'Disabled identity gate unexpectedly opened');
    echo "PASS: private HTTPS identity gates and spoofed-localhost rejection\n";
} finally {
    $_SERVER = $original;
    foreach (['QSYN_IDENTITY_ENABLED', 'QSYN_IDENTITY_STORAGE_DIR', 'QSYN_ENV',
              'QSYN_IDENTITY_ALLOWED_HOST', 'QSYN_PRIVATE_STAGING_CONFIRMED',
              'QSYN_ALLOW_HTTP_TEST'] as $key) {
        putenv($key);
    }
    chmod($root, 0700);
    rmdir($root);
}

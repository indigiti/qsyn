<?php
declare(strict_types=1);

// OFFLINE ONLY: usage php tools/verify-mock-audit.php /absolute/private/identity
// No web route may include or expose this inspector.
require_once dirname(__DIR__) . '/src/FileStore.php';
require_once dirname(__DIR__) . '/src/FileMockAuditLog.php';

if (PHP_SAPI !== 'cli' || count($argv) !== 2 || !str_starts_with($argv[1], '/')) {
    fwrite(STDERR, "Usage: php verify-mock-audit.php /absolute/private/mock-directory\n");
    exit(2);
}
try {
    $store = new \QSYN\Storage\FileStore($argv[1]);
    $result = (new \QSYN\Audit\FileMockAuditLog($store))->verifyAll();
    echo 'PASS: verified ' . $result['verified_events'] . " mock audit event HMAC seals\n";
} catch (\Throwable $error) {
    fwrite(STDERR, "FAIL: mock audit integrity not established\n");
    exit(1);
}

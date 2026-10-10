<?php
declare(strict_types=1);

/**
 * Read-only CLI preflight: verify Phase 1 mock user-facing features are OFF.
 * This tool does not deploy or claim that a network firewall/VPN is working.
 *
 * Run under the SAME PHP application environment as the staging worker.
 * Before any isolated feature trial, also require external ingress testing
 * and explicit operator authorization (see docs/PHASE1-STAGING-ACCEPTANCE.md).
 */
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$flags = [
    'QSYN_IDENTITY_ENABLED',
    'QSYN_MOCK_ACCOUNTS_ENABLED',
    'QSYN_DASHBOARD_ENABLED',
];
$enabled = array_values(array_filter($flags, static fn (string $name): bool =>
    getenv($name) === '1'));
if ($enabled !== []) {
    fwrite(STDERR, 'FAIL: enabled development-only feature: ' . implode(', ', $enabled) . "\n");
    exit(1);
}
echo "PASS: QSYN Phase 1 user identity, mock-account APIs and dashboard disabled\n";
echo "NOTE: offline-only gate check; external access controls must be tested separately\n";

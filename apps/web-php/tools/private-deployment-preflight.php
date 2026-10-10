<?php
declare(strict_types=1);

/**
 * Read-only structural preflight, never a deployment/enable command.
 *
 * php private-deployment-preflight.php public-disabled
 * php private-deployment-preflight.php private-preparation
 *
 * Run under the intended site's PHP environment with separate app roots.
 * A successful CLI check does NOT verify the PHP-FPM worker environment,
 * HTTPS certificate, ingress VPN/ACL, real deployed SHA, or rollback.
 */
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(2);
}

function preflightFail(string $reason): never
{
    // Sanitized reason codes only: no paths, secret values or environment dump.
    fwrite(STDERR, 'FAIL: ' . $reason . "\n");
    exit(1);
}

function flagIsOff(string $name): bool
{
    $value = getenv($name);
    return $value === false || $value === '' || $value === '0';
}

function offFlags(): void
{
    foreach ([
        'QSYN_IDENTITY_ENABLED',
        'QSYN_MOCK_ACCOUNTS_ENABLED',
        'QSYN_DASHBOARD_ENABLED',
        'QSYN_FIXTURE_BOOTSTRAP_ENABLED',
    ] as $name) {
        if (!flagIsOff($name)) {
            preflightFail('unsafe_phase1_feature_flag_' . strtolower($name));
        }
    }
}

function canonicalDirectory(string $key): string
{
    $input = getenv($key);
    if (!is_string($input) || !str_starts_with($input, '/') || str_contains($input, '/..')
        || is_link($input) || !is_dir($input)) {
        preflightFail('missing_or_unsafe_directory_' . strtolower($key));
    }
    $path = realpath($input);
    if ($path === false || $path === '/') {
        preflightFail('invalid_directory_' . strtolower($key));
    }
    return $path;
}

function inside(string $path, string $parent): bool
{
    return $path === $parent || str_starts_with($path, $parent . '/');
}

function ownerOnly(string $path): void
{
    clearstatcache(true, $path);
    $mode = fileperms($path);
    if ($mode === false || ($mode & 0077) !== 0) {
        preflightFail('identity_store_not_owner_only');
    }
}

if (($argc ?? 0) !== 2 || !in_array($argv[1] ?? '', [
    'public-disabled', 'private-preparation',
], true)) {
    preflightFail('expected_public-disabled_or_private-preparation');
}

offFlags();
if ($argv[1] === 'public-disabled') {
    echo "PASS: Phase 1 user account features and fixture bootstrap are disabled in this CLI environment\n";
    echo "LIMIT: Confirm PHP-FPM environment and HTTP denials independently\n";
    exit(0);
}

if (getenv('QSYN_ENV') !== 'development') {
    preflightFail('private_environment_must_be_development');
}

$host = (string) (getenv('QSYN_IDENTITY_ALLOWED_HOST') ?: '');
$hostname = strtolower(explode(':', $host)[0]);
if (preg_match('/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/D', $host) !== 1
    || !str_contains($hostname, '.')
    || in_array($hostname, [
        'stage.digiti.in', 'digiti.in', 'www.digiti.in', 'localhost',
    ], true)
    || filter_var($hostname, FILTER_VALIDATE_IP) !== false
    || filter_var($hostname, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME) === false) {
    preflightFail('invalid_or_public_private_host');
}

$publicApp = canonicalDirectory('QSYN_PUBLIC_STAGING_APP_ROOT');
$privateApp = canonicalDirectory('QSYN_PRIVATE_APP_ROOT');
$publicWeb = canonicalDirectory('QSYN_PUBLIC_STAGING_DOCROOT');
$privateWeb = canonicalDirectory('QSYN_PRIVATE_PUBLIC_DOCROOT');
$store = canonicalDirectory('QSYN_IDENTITY_STORAGE_DIR');

if (inside($publicApp, $privateApp) || inside($privateApp, $publicApp)
    || !inside($publicWeb, $publicApp) || !inside($privateWeb, $privateApp)
    || $publicWeb === $privateWeb
    || inside($store, $publicApp) || inside($store, $publicWeb)
    || inside($store, $privateWeb) || inside($privateWeb, $store)) {
    preflightFail('private_application_or_storage_not_isolated');
}
ownerOnly($store);

echo "PASS: private app/docroot separation, owner-only store and four disabled flags\n";
echo "LIMIT: Structural review only; NOT verified VPN/ACL, PHP-FPM flags, TLS, runtime or rollback\n";
echo "ACTION: independent two-vantage ingress tests and operator approval required before enabling accounts\n";

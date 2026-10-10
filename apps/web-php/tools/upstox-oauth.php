#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Operator shell only; never exposed by Apache or routing.
 * Environment must supply private absolute root + exact Upstox app settings.
 * Usage:
 *   php upstox-oauth.php begin
 *   printf '{"state":"...","code":"..."}' | php upstox-oauth.php finish
 *   php upstox-oauth.php status
 *
 * DO NOT log stdin or store token in a published app artifact.
 */
require_once dirname(__DIR__) . '/src/UpstoxOperatorOAuth.php';
use QSYN\Broker\UpstoxOperatorOAuth;

try {
    $root = (string) (getenv('QSYN_UPSTOX_PRIVATE_DIR') ?: '');
    $clientId = (string) (getenv('QSYN_UPSTOX_CLIENT_ID') ?: '');
    $redirect = (string) (getenv('QSYN_UPSTOX_REDIRECT_URI') ?: '');
    $userId = (string) (getenv('QSYN_UPSTOX_EXPECTED_USER_ID') ?: '');
    $oauth = new UpstoxOperatorOAuth($root);
    $op = $argv[1] ?? '';
    if (count($argv) !== 2) throw new RuntimeException('invalid_arguments');
    if ($op === 'begin') {
        echo $oauth->begin($clientId, $redirect, $userId) . PHP_EOL;
    } elseif ($op === 'finish') {
        $line = stream_get_contents(STDIN, 2048);
        $input = json_decode((string) $line, true, 8, JSON_THROW_ON_ERROR);
        if (!is_array($input) || array_keys($input) !== ['state', 'code']) {
            throw new RuntimeException('invalid_oauth_input');
        }
        $secretPath = $root . '/upstox-client-secret.key';
        $st = @lstat($secretPath);
        if (!$st || is_link($secretPath) || !is_file($secretPath)
            || ($st['mode'] & 0077) !== 0 || $st['size'] > 512
            || (function_exists('posix_geteuid') && $st['uid'] !== posix_geteuid())) {
            throw new RuntimeException('client_secret_file_not_private');
        }
        $secret = trim((string) file_get_contents($secretPath));
        $result = $oauth->finish(
            (string) ($input['state'] ?? ''), (string) ($input['code'] ?? ''),
            $secret, [UpstoxOperatorOAuth::class, 'exchangeWithCurl']
        );
        echo json_encode($result, JSON_THROW_ON_ERROR) . PHP_EOL;
    } elseif ($op === 'status') {
        echo json_encode($oauth->status(), JSON_THROW_ON_ERROR) . PHP_EOL;
    } else {
        throw new RuntimeException('invalid_oauth_command');
    }
} catch (\Throwable) {
    // Fail closed without printing credentials, auth codes, or HTTP response.
    fwrite(STDERR, "QSYN Upstox OAuth operator command declined; check private setup, account and login state.\n");
    exit(2);
}

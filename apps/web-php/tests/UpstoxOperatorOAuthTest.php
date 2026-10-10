<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/UpstoxOperatorOAuth.php';

use QSYN\Broker\UpstoxOperatorOAuth;
function ok(bool $yes): void { if (!$yes) throw new RuntimeException('oauth_fixture_assertion_failed'); }

$dir = sys_get_temp_dir() . '/qsyn-oauth-fixture-' . bin2hex(random_bytes(6));
mkdir($dir, 0700);
try {
    $api = new UpstoxOperatorOAuth($dir);
    ok($api->status()['token_stored'] === false);
    $url = $api->begin('upstoxclient123', 'https://example.test/qsyn/upstox-callback', 'USER123');
    $query = [];
    parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
    ok(str_starts_with($url, 'https://api.upstox.com/v2/login/authorization/dialog?'));
    ok(strlen($query['state']) === 64 && $query['response_type'] === 'code');
    ok((fileperms($dir . '/upstox-oauth-pending.json') & 0077) === 0);
    $wrongState = str_repeat('b', 64);
    $called = false;
    try {
        $api->finish($wrongState, 'single-use-code', 'supersecret-client', function () use (&$called) {
            $called = true;
            return [];
        });
        throw new RuntimeException('wrong_oauth_state_accepted');
    } catch (RuntimeException $ex) {
        ok($ex->getMessage() === 'oauth_state_invalid_or_expired');
    }
    ok(!$called);
    ok(!is_file($dir . '/upstox-oauth-pending.json'));
    try {
        $api->finish($query['state'], 'single-use-code', 'supersecret-client', static fn () => []);
        throw new RuntimeException('replayed_callback_accepted');
    } catch (RuntimeException) { /* consumed state must fail */ }

    $url = $api->begin('upstoxclient123', 'https://example.test/qsyn/upstox-callback', 'USER123');
    parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
    try {
        $api->finish($query['state'], 'single-use-code', 'supersecret-client',
            static fn (): array => ['user_id' => 'FOREIGN', 'token_type' => 'Bearer',
                'access_token' => str_repeat('x', 80)]);
        throw new RuntimeException('other_account_accepted');
    } catch (RuntimeException $ex) {
        ok($ex->getMessage() === 'oauth_broker_identity_not_verified');
    }
    ok($api->status()['token_stored'] === false);

    $url = $api->begin('upstoxclient123', 'https://example.test/qsyn/upstox-callback', 'USER123');
    parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
    $secret = 'server-secret-not-for-client';
    $result = $api->finish($query['state'], 'one-use-code123', $secret,
        static function (string $uri, array $form) use ($secret): array {
            ok($uri === 'https://api.upstox.com/v2/login/authorization/token');
            ok($form['client_secret'] === $secret);
            ok($form['grant_type'] === 'authorization_code');
            ok($form['code'] === 'one-use-code123');
            return ['user_id' => 'USER123', 'token_type' => 'Bearer',
                'access_token' => str_repeat('t', 96)];
        });
    ok($result['account_verified'] && $result['trading_enabled'] === false);
    ok($api->status()['token_stored'] && $api->status()['live_order_routing_enabled'] === false);
    ok((fileperms($dir . '/upstox-session.json') & 0077) === 0);
    $raw = (string) file_get_contents($dir . '/upstox-session.json');
    ok(str_contains($raw, str_repeat('t', 96)));
    ok(!str_contains(json_encode($api->status()), str_repeat('t', 96)));
    ok(!str_contains($raw, $secret));
    echo "PASS operator OAuth: CSRF one-use, wrong account, private token, no live-trade enablement\n";
} finally {
    foreach (glob($dir . '/*') ?: [] as $file) unlink($file);
    rmdir($dir);
}

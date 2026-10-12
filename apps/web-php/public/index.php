<?php
declare(strict_types=1);

// Phase 0 / development demo. This exposes no broker tokens and places no orders.
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
$route = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    exit;
}

if (in_array($route, ['/health', '/qsyn/health', '/api/v1/health', '/qsyn/api/v1/health'], true)) {
    respond(['status' => 'ok', 'app' => 'qsyn-web', 'phase' => 0, 'market_feed' => 'demo-only', 'app_store' => 'file']);
}

// Shared, credential-free market/provider metadata. The browser imports this
// same artifact at build time. Provider names never imply a live entitlement.
if ($route === '/qsyn/api/v1/markets/catalog') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET');
        respond(['error' => 'method_not_allowed'], 405);
    }
    $manifest = __DIR__ . '/market-provider-registry.json';
    if (!is_file($manifest) || is_link($manifest) || filesize($manifest) > 16384) {
        respond(['error' => 'market_registry_unavailable'], 503);
    }
    try {
        $data = json_decode((string)file_get_contents($manifest), true, 16, JSON_THROW_ON_ERROR);
    } catch (\\Throwable) {
        respond(['error' => 'market_registry_unavailable'], 503);
    }
    if (!is_array($data)
        || ($data['schema'] ?? null) !== 'QSYN-MARKET-PROVIDER-REGISTRY/1'
        || count($data['markets'] ?? []) !== 4
        || !is_array($data['providers'] ?? null)) {
        respond(['error' => 'market_registry_invalid'], 503);
    }
    respond($data);
}

if ($route === '/qsyn/api/v1/diagnostics/rust-stream' || $route === '/api/v1/diagnostics/rust-stream') {
    // Simulated quotes ONLY. Never expose broker market data through this public endpoint.
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET');
        respond(['error' => 'method_not_allowed'], 405);
    }
    $source = dirname(__DIR__) . '/src/RustStreamProbe.php';
    if (!is_file($source)) {
        $source = dirname(__DIR__, 2) . '/private_html/qsyn/app/src/RustStreamProbe.php';
    }
    if (!is_file($source)) {
        respond(['status' => 'unavailable', 'reason' => 'stream_probe_not_installed'], 503);
    }
    require_once $source;
    respond(\QSYN\Diagnostics\RustStreamProbe::inspect());
}

if ($route === '/qsyn/api/v1/diagnostics/rust' || $route === '/api/v1/diagnostics/rust') {
    // Public Phase-0 read-only signal. No shell, token, path, or target control.
    // In production replace this with an authenticated administrator API.
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET');
        respond(['error' => 'method_not_allowed'], 405);
    }
    $probeFile = dirname(__DIR__) . '/src/RustProbe.php';
    if (!is_file($probeFile)) {
        $probeFile = dirname(__DIR__, 2) . '/private_html/qsyn/app/src/RustProbe.php';
    }
    if (!is_file($probeFile)) {
        respond(['status' => 'unavailable', 'reason' => 'probe_not_installed'], 503);
    }
    require_once $probeFile;
    respond(\QSYN\Diagnostics\RustProbe::inspect());
}

// Indian indexes are discoverable but never expose unlicensed NSE/BSE candles.
// A future authorized account-scoped Upstox adapter must replace the closed
// read-only contract after exchange display entitlement is verified.
if ($route === '/qsyn/api/v1/india/indexes' || $route === '/qsyn/api/v1/india/bars') {
    $source = dirname(__DIR__) . '/src/IndiaIndexCatalog.php';
    if (!is_file($source)) {
        $source = dirname(__DIR__, 2) . '/private_html/qsyn/app/src/IndiaIndexCatalog.php';
    }
    if (!is_file($source)) respond(['error' => 'india_index_catalog_unavailable'], 503);
    require_once $source;
    [$status, $payload] = \QSYN\MarketData\IndiaIndexCatalog::dispatch(
        str_ends_with($route, '/indexes') ? 'indexes' : 'bars', $_GET, $_SERVER
    );
    if ($status === 405) header('Allow: GET');
    respond($payload, $status);
}

// Public crypto candles: strict query allowlist and loopback Rust only.
// No client-chosen host, port, URL, API token, private account, or order route.
if ($route === '/qsyn/api/v1/crypto/bars' || $route === '/qsyn/api/v1/crypto/health') {
    $cryptoHealth = $route === '/qsyn/api/v1/crypto/health';
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET'); respond(['error' => 'method_not_allowed'], 405);
    }
    $exchange = $_GET['exchange'] ?? '';
    $market = $_GET['market'] ?? '';
    $symbol = $_GET['symbol'] ?? '';
    $interval = $_GET['interval'] ?? '';
    $limit = $_GET['limit'] ?? '250';
    $before = $_GET['before'] ?? null; // strictly exclusive UTC-second cursor
    if (!is_string($exchange) || !is_string($market) || !is_string($symbol)
        || !is_string($interval) || !is_string($limit)
        || !preg_match('/\A[A-Z]{2,16}\z/', $exchange)
        || !in_array($market, ['spot', 'perp'], true)
        || !preg_match('/\A[A-Z0-9-]{2,32}\z/', $symbol)
        || !in_array($interval, ['1m','5m','15m','1h','1d'], true)
        || !ctype_digit($limit) || (int)$limit < 1 || (int)$limit > 300
        || ($before !== null && ($cryptoHealth || !is_string($before)
            || !preg_match('/\\A[1-9][0-9]{9}\\z/', $before)
            || (int)$before > time()+86400
            || (int)$before < 1500000000
            || (int)$before < time() - 15316 * (['1m'=>60,'5m'=>300,'15m'=>900,'1h'=>3600,'1d'=>86400][$interval] ?? 1)
            || ((int)$before) % (['1m'=>60,'5m'=>300,'15m'=>900,'1h'=>3600,'1d'=>86400][$interval] ?? 1) !== 0))) {
        respond(['error' => 'invalid_crypto_request'], 422);
    }
    $params = compact('exchange', 'market', 'symbol', 'interval', 'limit');
    if ($before !== null) $params['before'] = $before;
    $params = http_build_query($params, '', '&', PHP_QUERY_RFC3986);
    $ch = curl_init('http://127.0.0.1:10251/api/v1/crypto/' . ($cryptoHealth ? 'health' : 'bars') . '?' . $params);
    if ($ch === false) respond(['error' => 'crypto_gateway_unavailable'], 503);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => 10, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if (!is_string($body) || strlen($body) > 1000000 || $status !== 200) {
        respond(['error' => 'crypto_market_data_unavailable'], 503);
    }
    $data = json_decode($body, true);
    if (!is_array($data) || ($data['schema'] ?? '') !== ($cryptoHealth ? 'QSYN-PUBLIC-CRYPTO-HEALTH/1' : 'QSYN-PUBLIC-CRYPTO-BARS/1')
        || ($data['source'] ?? '') !== 'exchange_public'
        || ($data['trading_enabled'] ?? true) !== false
        || ($data['exchange'] ?? '') !== $exchange || ($data['market'] ?? '') !== $market
        || ($data['symbol'] ?? '') !== $symbol || ($data['interval'] ?? '') !== $interval
        || ($cryptoHealth ? !is_array($data['feed'] ?? null) : !is_array($data['bars'] ?? null))
        || (!$cryptoHealth && $before !== null
            && (!isset($data['pagination']) || !is_array($data['pagination'])
                || ($data['pagination']['before'] ?? null) !== (int)$before
                || !is_bool($data['pagination']['has_more'] ?? null)))) {
        respond(['error' => 'crypto_gateway_invalid_response'], 502);
    }
    respond($data);
}

// Integrated Options Studio is a public, read-only simulation, NOT a broker API.
// It is independent of disabled-by-default user/account/fixture features.
if ($route === '/qsyn/api/v1/studio/market' || $route === '/qsyn/api/v1/studio/bars'
    || $route === '/qsyn/api/v1/studio/capabilities') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET');
        respond(['error' => 'method_not_allowed'], 405);
    }
    if ($route === '/qsyn/api/v1/studio/capabilities') {
        respond([
            'schema' => 'QSYN-STUDIO-CAPABILITIES/1', 'market_data' => 'simulated',
            'broker_integration' => 'not_connected', 'execution_enabled' => false,
            'live_trading_enabled' => false, 'live_telemetry_approved' => false,
            'market_data_feed' => 'deterministic-options-laboratory',
            'paper_trades' => 'browser_local_only', 'paper_orders_sent_to_broker' => false,
            'alerts' => 'browser_foreground_only', 'history' => 'deterministic_120_bars',
        ]);
    }
    $source = dirname(__DIR__) . '/src/SimulatedOptionsStudio.php';
    if (!is_file($source)) {
        $source = dirname(__DIR__, 2) . '/private_html/qsyn/app/src/SimulatedOptionsStudio.php';
    }
    if (!is_file($source)) {
        respond(['error' => 'simulated_studio_unavailable'], 503);
    }
    require_once $source;
    try {
        $underlying = $_GET['underlying'] ?? 'NIFTY';
        if (!is_string($underlying)) {
            respond(['error' => 'invalid_demo_underlying'], 422);
        }
        if ($route === '/qsyn/api/v1/studio/market') {
            respond(\QSYN\Studio\SimulatedOptionsStudio::market($underlying));
        }
        $expiry = $_GET['expiry'] ?? 'W1';
        $interval = $_GET['interval'] ?? '1m';
        $legs = $_GET['legs'] ?? '';
        if (!is_string($expiry) || !is_string($interval) || !is_string($legs)
            || strlen($legs) > 1400) {
            respond(['error' => 'invalid_studio_parameters'], 422);
        }
        $series = \QSYN\Studio\SimulatedOptionsStudio::bars($underlying, $expiry, $interval, $legs);
        $analytics = dirname($source) . '/StudioAnalytics.php';
        if (!is_file($analytics)) {
            respond(['error' => 'studio_analytics_unavailable'], 503);
        }
        require_once $analytics;
        $series['analytics'] = \QSYN\Studio\StudioAnalytics::summarize($series);
        respond($series);
    } catch (\InvalidArgumentException $error) {
        // Stable non-sensitive validation codes only; never echo arbitrary request data.
        respond(['error' => $error->getMessage()], 422);
    }
}

// Password-protected, redacted diagnostic snapshot. No token, user identity,
// account number, cookie value, provider payload or private path is serialized.
if ($route === '/qsyn/api/v1/admin/diagnostics/report') {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/NativeAdminDiagnostics.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['RustAdmin', 'NativeAdminDiagnostics'] as $module) {
        if (!is_file($src . '/' . $module . '.php')) {
            respond(['error' => 'diagnostics_module_unavailable'], 503);
        }
        require_once $src . '/' . $module . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('X-Robots-Tag: noindex, nofollow');
    [$status, $payload] = \QSYN\Diagnostics\NativeAdminDiagnostics::read($_SERVER);
    header('X-QSYN-Request-ID: ' . $payload['request_id']);
    respond($payload, $status);
}

// Administrator-only read-only Upstox Analytics Token intake (opt-in).
// This does not modify the OAuth file, attest account identity, authorize
// exchange redistribution or enable worker/trading. No secrets in responses.
if (preg_match('#^/qsyn/api/v1/admin/upstox/analytics/(status|import|clear|verify)$#', $route, $analytics)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/NativeUpstoxAnalyticsApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['RustAdmin','NativeUpstoxAnalyticsApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error'=>'analytics_module_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('Referrer-Policy: no-referrer');
    header('X-Robots-Tag: noindex, nofollow');
    [$status,$payload] = \QSYN\Broker\NativeUpstoxAnalyticsApi::dispatch($analytics[1], $_SERVER);
    if ($status === 405) header('Allow: '.($analytics[1] === 'status' ? 'GET' : 'POST'));
    $requestId = bin2hex(random_bytes(8));
    header('X-QSYN-Request-ID: ' . $requestId);
    $payload['request_id'] = $requestId;
    respond($payload, $status);
}

// Native Upstox operator OAuth. No OpenAlgo Python or API key is involved.
// The callback accepts a one-use 256-bit state instead of an admin cookie:
// external Upstox redirects will not carry our SameSite=Strict admin session.
if (preg_match('#^/qsyn/api/v1/admin/upstox/(status|setup|begin|verify|discover|callback)$#', $route, $nativeUpstox)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/NativeUpstoxWebApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['RustAdmin','UpstoxOperatorOAuth','NativeUpstoxProfileVerifier','NativeUpstoxIndexDiscovery','NativeUpstoxWebApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'upstox_web_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('Referrer-Policy: no-referrer');
    header('X-Robots-Tag: noindex, nofollow');
    [$status, $payload] = \QSYN\Broker\NativeUpstoxWebApi::dispatch(
        $nativeUpstox[1], $_SERVER, $_GET
    );
    if ($status === 405) header('Allow: ' . ($nativeUpstox[1] === 'setup'
        || $nativeUpstox[1] === 'begin' ? 'POST' : 'GET'));
    if ($status === 303) {
        header('Location: ' . $payload['location'], true, 303);
        exit;
    }
    $requestId = bin2hex(random_bytes(8));
    header('X-QSYN-Request-ID: ' . $requestId);
    $payload['request_id'] = $requestId;
    respond($payload, $status);
}

// Public broker names; private account selection, login and status are gated by
// the existing development identity and separate explicit runtime opt-in.
if (preg_match('#^/qsyn/api/v1/brokers/openalgo/(catalog|accounts|status|connect)$#', $route, $brokerMatch)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/OpenAlgoBrokerConnectionsApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['FileStore', 'UserRepository', 'FileUserRepository', 'UserSession',
        'IdentityApi', 'OpenAlgoLocalProbe', 'PrivateBrokerRegistry',
        'OpenAlgoBrokerConnectionsApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'broker_modules_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('X-Robots-Tag: noindex, nofollow');
    [$status, $payload] = \QSYN\Broker\OpenAlgoBrokerConnectionsApi::dispatch(
        $brokerMatch[1], $_SERVER, $_GET
    );
    if ($status === 405) header('Allow: ' . ($brokerMatch[1] === 'connect' ? 'POST' : 'GET'));
    respond($payload, $status);
}

// Administrator-only OpenAlgo readiness. Reuses the existing separate QSYN
// Rust administrator password/session; no mock user identities or broker keys
// enter the browser. Read-only status and approved upstream login handoff.
if (preg_match('#^/qsyn/api/v1/admin/openalgo/(accounts|connect|inspect|setup)$#', $route, $openAlgoAdmin)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/OpenAlgoAdminWebApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['RustAdmin', 'OpenAlgoLocalProbe', 'PrivateBrokerRegistry',
        'OpenAlgoBrokerConnectionsApi', 'OpenAlgoAdminSetup', 'OpenAlgoAdminWebApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'admin_broker_modules_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('X-Robots-Tag: noindex, nofollow');
    [$status, $payload] = $openAlgoAdmin[1] === 'setup'
        ? \QSYN\Broker\OpenAlgoAdminSetup::dispatch($_SERVER)
        : \QSYN\Broker\OpenAlgoAdminWebApi::dispatch(
            $openAlgoAdmin[1], $_SERVER
        );
    if ($status === 405) {
        header('Allow: ' . ($openAlgoAdmin[1] === 'accounts' ? 'GET' : 'POST'));
    }
    respond($payload, $status);
}

// Server-side administrator-only terminal gate. This runs before React,
// pretty-URL redirects, studio/legacy aliases, and terminal shell rendering.
// The public chart-only /qsyn/ homepage is deliberately excluded.
$isTerminalDocument = $route === '/qsyn/terminal'
    || str_starts_with($route, '/qsyn/terminal/')
    || in_array($route, [
        '/qsyn/studio', '/qsyn/studio/',
        '/qsyn/admin/rust', '/qsyn/admin/rust/',
        '/qsyn/legacy-chart', '/qsyn/legacy-chart/',
    ], true);
if ($isTerminalDocument) {
    $gateSource = dirname(__DIR__) . '/src';
    if (!is_file($gateSource . '/TerminalAdminGate.php')) {
        $gateSource = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['RustAdmin', 'RustAdminBootstrap', 'TerminalAdminGate'] as $unit) {
        if (!is_file($gateSource . '/' . $unit . '.php')) {
            respond(['error' => 'terminal_auth_unavailable'], 503);
        }
        require_once $gateSource . '/' . $unit . '.php';
    }
    \QSYN\Routing\TerminalAdminGate::enforce(
        $route, $_SERVER, __DIR__ . '/terminal-login.php'
    );
}

// Central terminal route management: one reviewed JSON registry consumed by
// PHP and React. This block handles only UI navigation, not any protected API.
if (str_starts_with($route, '/qsyn/terminal') || in_array($route, [
    '/qsyn/studio','/qsyn/studio/',
    '/qsyn/admin/rust','/qsyn/admin/rust/',
    '/qsyn/legacy-chart','/qsyn/legacy-chart/',
], true)) {
    $routingSource = dirname(__DIR__) . '/src/TerminalRoutes.php';
    if (!is_file($routingSource)) {
        $routingSource = dirname(__DIR__, 2) . '/private_html/qsyn/app/src/TerminalRoutes.php';
    }
    $manifest = __DIR__ . '/terminal-routes.json';
    if (!is_file($routingSource) || !is_file($manifest)) {
        respond(['error' => 'terminal_routing_unavailable'], 503);
    }
    require_once $routingSource;
    try {
        $routes = new \QSYN\Routing\TerminalRoutes($manifest);
    } catch (\RuntimeException) {
        respond(['error' => 'terminal_routing_unavailable'], 503);
    }
    if ($routes->isAlias($route) || $routes->isTerminalRequest($route)) {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if ($method !== 'GET' && $method !== 'HEAD') {
            header('Allow: GET, HEAD');
            respond(['error' => 'method_not_allowed'], 405);
        }
        $legacyView = $_GET['view'] ?? null;
        $target = $routes->target($route, is_string($legacyView) ? $legacyView : null);
        if ($target !== null) {
            header('Cache-Control: private, no-store, max-age=0');
            header('Pragma: no-cache');
            header('X-Robots-Tag: noindex, nofollow');
            header('Location: ' . $target, true, 302);
            exit;
        }
        if (!$routes->isValidPath($route)) {
            respond(['error' => 'terminal_route_not_found'], 404);
        }
    }
}

// Chart-first public homepage and canonical terminal share the same React
// shell. This renders in place at /qsyn/ (no redirect or URL change), with
// simulated candles and the existing disabled broker / OMS actions.
// Legacy HTML entrypoints now redirect into terminal workspaces.
if (in_array($route, ['/', '/qsyn', '/qsyn/'], true)
    || (isset($routes) && $routes->isValidPath($route))) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET');
        respond(['error' => 'method_not_allowed'], 405);
    }
    if (!is_file(__DIR__ . '/assets/terminal.js') || !is_file(__DIR__ . '/assets/terminal.css')) {
        respond(['error' => 'terminal_bundle_unavailable'], 503);
    }
    header('Content-Type: text/html; charset=utf-8');
    // A fresh response nonce is also used by Cloudflare's JSD injection.
    // Keep bot detection available without permitting arbitrary inline JS.
    $qsynCspNonce = base64_encode(random_bytes(18));
    header('Cache-Control: no-store');
    header('X-Frame-Options: DENY');
    header('X-Robots-Tag: noindex, nofollow');
    header('Content-Security-Policy: default-src ' . "'self'" .
        '; script-src ' . "'self' 'nonce-" . $qsynCspNonce . "'" . '; style-src ' . "'self' 'unsafe-inline'" .
        '; connect-src ' . "'self'" . '; img-src ' . "'self' data:" .
        '; frame-ancestors ' . "'none'" . ';');
    require __DIR__ . '/terminal.php';
    exit;
}

// Independently opted-in, identity-scoped PRIVATE simulated terminal file
// workspaces. Never expose this during public/demo UI deployment. Without an
// authenticated mock developer identity the endpoint fails closed.
if ($route === '/qsyn/api/v1/terminal/workspace') {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/TerminalWorkspaceApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['FileStore', 'UserRepository', 'FileUserRepository', 'UserSession',
        'IdentityApi', 'FileMockAuditLog', 'FileTerminalWorkspaceRepository',
        'TerminalWorkspaceApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'private_workspace_modules_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    header('Cache-Control: private, no-store');
    [$status, $payload] = \QSYN\Terminal\TerminalWorkspaceApi::dispatch($_SERVER);
    respond($payload, $status);
}

// Explicitly enabled, authenticated single-operator NSE/BSE index viewer.
// Separate from mock identity, public market data and broker OAuth. A short
// viewer grant still REQUIRES independently provisioned current private rights.
if (in_array($route, [
    '/qsyn/api/v1/admin/upstox/private-chart-access',
    '/qsyn/api/v1/admin/upstox/private-chart-grant',
], true)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/OperatorIndexChartGrantApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['RustAdmin', 'OperatorIndexChartGrantApi'] as $module) {
        if (!is_file($src . '/' . $module . '.php')) {
            respond(['error'=>'private_operator_chart_module_unavailable'], 503);
        }
        require_once $src . '/' . $module . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('X-Robots-Tag: noindex, nofollow');
    [$status, $payload] = \QSYN\MarketData\OperatorIndexChartGrantApi::dispatch(
        $_SERVER,
        str_ends_with($route, 'private-chart-access') ? 'access' : 'grant'
    );
    if ($status === 405) header('Allow: ' . (str_ends_with($route, 'private-chart-access') ? 'GET' : 'POST'));
    respond($payload, $status);
}

// Dev/private ONLY: issue a 30-second instrument-scoped chart WSS grant.
// The rights file and Rust private chart server remain operator provisioned.
// No open public chart websocket or broker session is configured by this route.
if ($route === '/qsyn/api/v1/terminal/private-chart-grant') {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/PrivateChartGrantApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['FileStore', 'UserRepository', 'FileUserRepository', 'UserSession',
        'IdentityApi', 'PrivateChartGrantApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'private_chart_modules_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    header('Cache-Control: private, no-store');
    header('Pragma: no-cache');
    header('X-Robots-Tag: noindex, nofollow');
    [$status, $payload] = \QSYN\MarketData\PrivateChartGrantApi::dispatch($_SERVER);
    respond($payload, $status);
}

// Deliberately disabled-by-default QSYN *user* identity test API.
// Separate cookie and code from the Rust operations administrator.
if (preg_match('#^/qsyn/api/v1/auth/(state|me|login|logout)$#', $route, $identityMatch)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/IdentityApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['FileStore', 'UserRepository', 'FileUserRepository', 'IdentityThrottle', 'UserSession', 'FileMockAuditLog', 'IdentityApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'identity_modules_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    [$status, $payload] = \QSYN\Identity\IdentityApi::dispatch($identityMatch[1], $_SERVER);
    respond($payload, $status);
}

// Phase 1.3: session-owned simulated account control; disabled by default.
// No real broker credentials, account linking or order execution.
if (preg_match('#^/qsyn/api/v1/accounts/(list|get|bars|workspace|link|rename|select|disconnect|save-workspace)$#', $route, $accountMatch)) {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/AccountApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    foreach (['FileStore', 'UserRepository', 'FileUserRepository',
        'UserSession', 'IdentityApi', 'BrokerConnectionRepository',
        'FileMockBrokerConnectionRepository', 'FileMockAccountSelection', 'FileMockWorkspaceRepository',
        'FileMockAuditLog', 'SimulatedAccountBars', 'AccountApi'] as $unit) {
        if (!is_file($src . '/' . $unit . '.php')) {
            respond(['error' => 'mock_account_modules_unavailable'], 503);
        }
        require_once $src . '/' . $unit . '.php';
    }
    [$status, $payload] = \QSYN\Accounts\AccountApi::dispatch($accountMatch[1], $_SERVER);
    respond($payload, $status);
}

// Phase 1.4 isolated browser workspace; opt-in test/development only.
// Deliberately separate from the legacy /qsyn/ chart and Rust admin page.
if ($route === '/qsyn/app' || $route === '/qsyn/app/') {
    $src = dirname(__DIR__) . '/src';
    if (!is_file($src . '/IdentityApi.php')) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    if (!is_file($src . '/IdentityApi.php')) {
        respond(['error' => 'dashboard_unavailable'], 404);
    }
    // IdentityApi private-root gating also validates UserSession transport.
    require_once $src . '/UserSession.php';
    require_once $src . '/IdentityApi.php';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    $localhostTest = getenv('QSYN_ENV') === 'test' && getenv('QSYN_ALLOW_HTTP_TEST') === '1'
        && preg_match('/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/D', $host) === 1;
    if (getenv('QSYN_DASHBOARD_ENABLED') !== '1'
        || getenv('QSYN_MOCK_ACCOUNTS_ENABLED') !== '1'
        || \QSYN\Identity\IdentityApi::privateRoot() === null
        || (!$localhostTest && ($_SERVER['HTTPS'] ?? '') !== 'on'
            && (string) ($_SERVER['SERVER_PORT'] ?? '') !== '443')) {
        respond(['error' => 'dashboard_not_enabled'], 404);
    }
    header('Content-Type: text/html; charset=utf-8');
    // Separate fresh nonce for the optional private dashboard HTML.
    $qsynCspNonce = base64_encode(random_bytes(18));
    header('Cache-Control: private, no-store');
    header('X-Frame-Options: DENY');
    header('X-Robots-Tag: noindex, nofollow');
    header('Content-Security-Policy: default-src ' . "'self'" .
        '; script-src ' . "'self' 'nonce-" . $qsynCspNonce . "'" . '; style-src ' . "'self' 'unsafe-inline'" .
        '; connect-src ' . "'self'" . '; img-src ' . "'self' data:" . '; frame-ancestors ' . "'none'" . ';');
    require __DIR__ . '/account-dashboard.php';
    exit;
}

// Administrator-only Rust service control. Never accessible without a configured
// admin password, valid PHP session, CSRF token and allowlisted local adapter.
if (preg_match('#^(?:/qsyn)?/api/v1/admin/rust/(state|login|logout|action|demo|setup)$#', $route, $matches)) {
    $operation = $matches[1];
    $source = dirname(__DIR__) . '/src';
    if (!is_file($source . '/RustAdmin.php')) {
        $source = dirname(__DIR__, 2) . '/private_html/qsyn/app/src';
    }
    if (!is_file($source . '/RustAdmin.php') || !is_file($source . '/RustSupervisor.php')) {
        respond(['error' => 'admin_modules_unavailable'], 503);
    }
    require_once $source . '/RustAdmin.php';
    require_once $source . '/RustSupervisor.php';
    if (!is_file($source . '/RustAdminBootstrap.php')) {
        respond(['error' => 'setup_module_unavailable'], 503);
    }
    require_once $source . '/RustAdminBootstrap.php';
    \QSYN\Admin\RustAdmin::boot();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $expected = ($operation === 'state' || ($operation === 'demo' && $method === 'GET')) ? 'GET' : 'POST';
    if ($method !== $expected) {
        header('Allow: ' . $expected);
        respond(['error' => 'method_not_allowed'], 405);
    }
    if ($method === 'POST') {
        if (!\QSYN\Admin\RustAdmin::originAllowed($_SERVER)) {
            respond(['error' => 'origin_not_allowed'], 403);
        }
        if (stripos((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') !== 0) {
            respond(['error' => 'content_type_required'], 415);
        }
        $raw = file_get_contents('php://input', false, null, 0, 2048);
        $data = json_decode($raw === false ? '' : $raw, true);
        if (!is_array($data)) {
            respond(['error' => 'invalid_json'], 400);
        }
    } else {
        $data = [];
    }

    if ($operation === 'login') {
        if (!\QSYN\Admin\RustAdmin::configured()) {
            respond(['error' => 'admin_not_configured'], 503);
        }
        if (!\QSYN\Admin\RustAdmin::attempt((string)($data['password'] ?? ''))) {
            respond(['error' => 'invalid_credentials'], 401);
        }
        respond(['authenticated' => true, 'csrf' => \QSYN\Admin\RustAdmin::csrf()]);
    }

    if ($operation === 'setup') {
        if (!\QSYN\Admin\RustAdminBootstrap::validCsrf((string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
            respond(['error' => 'csrf_invalid'], 403);
        }
        $setupCode = (string)($data['setup_code'] ?? '');
        $newPassword = (string)($data['new_password'] ?? '');
        $result = \QSYN\Admin\RustAdminBootstrap::complete($setupCode, $newPassword);
        respond($result, ($result['ok'] ?? false) ? 200 : 403);
    }

    if ($operation === 'state') {
        $authorized = \QSYN\Admin\RustAdmin::authenticated();
        respond([
            'configured' => \QSYN\Admin\RustAdmin::configured(),
            'setup' => $authorized ? ['available' => false] : (static function (): array {
                $setup = \QSYN\Admin\RustAdminBootstrap::status();
                return [
                    'available' => $setup['available'],
                    'reason' => $setup['reason'],
                    'csrf' => $setup['available'] ? \QSYN\Admin\RustAdminBootstrap::csrf() : null,
                ];
            })(),
            'authenticated' => $authorized,
            'session' => \QSYN\Admin\RustAdmin::sessionReport(),
            'csrf' => $authorized ? \QSYN\Admin\RustAdmin::csrf() : null,
            'manager' => $authorized ? \QSYN\Admin\RustSupervisor::status() : null,
        ]);
    }

    if (!\QSYN\Admin\RustAdmin::authenticated()) {
        respond(['error' => 'unauthorized'], 401);
    }
    if ($operation === 'demo') {
        if (!is_file($source . '/RustDemoConfig.php') || !is_file($source . '/RustProbe.php')) {
            respond(['error' => 'demo_control_unavailable'], 503);
        }
        require_once $source . '/RustProbe.php';
        require_once $source . '/RustDemoConfig.php';
        if ($method === 'GET') {
            respond(\QSYN\Admin\RustDemoConfig::state());
        }
    }
    if (!\QSYN\Admin\RustAdmin::verifyCsrf((string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        respond(['error' => 'csrf_invalid'], 403);
    }
    if ($operation === 'logout') {
        \QSYN\Admin\RustAdmin::logout();
        respond(['authenticated' => false]);
    }
    if ($operation === 'demo') {
        if (!array_key_exists('enabled', $data) || !is_bool($data['enabled'])) {
            respond(['error' => 'enabled_must_be_boolean'], 422);
        }
        $outcome = \QSYN\Admin\RustDemoConfig::change($data['enabled']);
        respond($outcome, $outcome['ok'] ? 200 : 409);
    }
    if ($operation === 'action') {
        $action = (string)($data['action'] ?? '');
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            respond(['error' => 'invalid_action'], 422);
        }
        $outcome = \QSYN\Admin\RustSupervisor::execute($action);
        respond($outcome, $outcome['ok'] ? 200 : 503);
    }
    respond(['error' => 'not_found'], 404);
}

if (str_ends_with($route, '/api/v1/demo/bars')) {
    $end = intdiv(time(), 60) * 60;
    $bars = [];
    for ($i = 119; $i >= 0; --$i) {
        $step = 119 - $i;
        $close = round(220 + sin($step / 7.0) * 13 + cos($step / 19.0) * 8, 2);
        $open = round(220 + sin(($step - 1) / 7.0) * 13 + cos(($step - 1) / 19.0) * 8, 2);
        $bars[] = [
            'time' => $end - $i * 60,
            'open' => $open,
            'high' => round(max($open, $close) + 2.0, 2),
            'low' => round(min($open, $close) - 2.0, 2),
            'close' => $close,
            'volume' => 0,
        ];
    }
    respond(['symbol' => 'QSYN-DEMO', 'exchange' => 'QSYN', 'mode' => 'simulated', 'bars' => $bars]);
}

// Retired legacy HTML is not a second application. The supported UI is
// /qsyn/terminal; all authorized service endpoints remain separately routed.
respond(['error' => 'not_found'], 404);

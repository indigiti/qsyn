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

if (str_ends_with($route, '/health') || str_ends_with($route, '/api/v1/health')) {
    respond(['status' => 'ok', 'app' => 'qsyn-web', 'phase' => 0, 'market_feed' => 'demo-only', 'app_store' => 'file']);
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

// Administrator-only Rust service control. Never accessible without a configured
// admin password, valid PHP session, CSRF token and allowlisted local adapter.
if (preg_match('#^(?:/qsyn)?/api/v1/admin/rust/(state|login|logout|action|demo)$#', $route, $matches)) {
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

    if ($operation === 'state') {
        $authorized = \QSYN\Admin\RustAdmin::authenticated();
        respond([
            'configured' => \QSYN\Admin\RustAdmin::configured(),
            'authenticated' => $authorized,
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

if ($route === '/qsyn/admin/rust' || $route === '/qsyn/admin/rust/') {
    header('Content-Type: text/html; charset=utf-8');
    header('Content-Security-Policy: default-src ' . "'self'" . '; script-src ' . "'self'" . '; style-src ' . "'self' 'unsafe-inline'" . '; connect-src ' . "'self'" . '; img-src ' . "'self' data:" . ';');
    require __DIR__ . '/admin-rust.php';
    exit;
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

if ($route !== '/' && $route !== '/qsyn' && $route !== '/qsyn/') {
    respond(['error' => 'not_found'], 404);
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: private, no-store');
header('Content-Security-Policy: default-src ' . "'self'" . '; script-src ' . "'self'" . '; style-src ' . "'self' 'unsafe-inline'" . '; connect-src ' . "'self'" . '; img-src ' . "'self' data:" . ';');
// A new DigiOps chart bundle receives a new file timestamp. Keep the HTML
// uncacheable; let browsers cache only the explicitly versioned static asset.
$chartBundleVersion = (string)(@filemtime(__DIR__ . '/assets/chart.js') ?: '0');
$diagnosticsVersion = (string)(@filemtime(__DIR__ . '/assets/chart-diagnostics.js') ?: '0');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QSYN — Development Terminal</title>
<script src="/qsyn/assets/chart-diagnostics.js?v=<?= rawurlencode($diagnosticsVersion) ?>"></script>
<style>
html,body{margin:0;background:#0b111b;color:#e5eaf3;font:14px system-ui,sans-serif}
header{padding:18px 24px;border-bottom:1px solid #303b4b;display:flex;align-items:center;gap:14px}
header strong{font-size:19px} .tag{background:#18314a;color:#8cceff;padding:5px 10px;border-radius:6px}
main{padding:20px;max-width:1600px;margin:auto} h1{font-size:20px;font-weight:600}
.diagnostics{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;border:1px solid #334155;border-radius:9px;background:#101a29;padding:14px 18px;margin:0 0 16px}
.diagnostics strong{font-size:14px}.diagnostics p{margin:7px 0 0;color:#9eacc0;font-size:12px;line-height:1.5}
.diagnostics button{background:#235ca5;color:#fff;padding:9px 15px;border:1px solid #4987d6;border-radius:6px;cursor:pointer;font-weight:600}
.diagnostics button:disabled{opacity:.6;cursor:wait}.diagnostics output{font-size:13px;font-weight:600;color:#c5d6eb}
#terminal{height:min(73vh,800px);min-height:410px;border:1px solid #303b4b;border-radius:9px;overflow:hidden}
.chart-top{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px}
.chart-top h1{margin:0 12px 0 0}
.chart-top button{background:#243a57;color:#eaf4ff;border:1px solid #4c709d;border-radius:6px;padding:8px 12px;cursor:pointer;font-weight:600}
.chart-top button:disabled{opacity:.55;cursor:wait}
#chart-reset-status{color:#a8c6e7;font-size:12px}
.note{color:#a8b9ce;font-size:12px;margin-top:12px;line-height:1.6}
.chart-debug{border:1px solid #34455c;border-radius:9px;padding:12px 16px;margin:14px 0;color:#c5d6eb}
.chart-debug summary{cursor:pointer;font-weight:700}
.chart-debug p{font-size:12px;color:#a8b9ce}
.chart-debug button{background:#253d5b;border:1px solid #4c709d;color:#f0f5ff;border-radius:6px;padding:7px 12px;cursor:pointer;margin-right:8px}
.chart-debug button:disabled{opacity:.5;cursor:not-allowed}
.chart-debug pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;font-size:12px;color:#b5d2f0}
.chart-preview{margin-top:12px;border:1px solid #41536d;padding:10px;border-radius:8px;background:#080d14}
.chart-preview img{display:block;width:100%;height:auto;max-height:640px;object-fit:contain}
.chart-preview figcaption{font-size:12px;margin-top:8px;color:#a7bed8}
</style>
</head>
<body>
<header><strong>QSYN</strong><span class="tag">Phase 0 · Simulated data</span><a href="/qsyn/admin/rust" style="color:#a9caff;margin-left:auto">Rust administration</a></header>
<main>
<div class="chart-top">
  <h1>Chart terminal foundation</h1>
  <button type="button" id="chart-reset" title="Refit all loaded demo candles to the visible chart">Reset chart view</button>
  <output id="chart-reset-status" role="status" aria-live="polite"></output>
</div>
<section class="diagnostics" aria-labelledby="rust-title">
  <div>
    <strong id="rust-title">Rust realtime engine — browser test</strong>
    <p id="rust-details">Runs a read-only localhost health and WebSocket check through PHP. It does not start the engine.</p>
  </div>
  <div>
    <button type="button" id="rust-test">Test Rust service</button>
    <output id="rust-result" role="status" aria-live="polite">Not checked</output>
  </div>
</section>
<section class="diagnostics" aria-labelledby="stream-title">
  <div>
    <strong id="stream-title">Rust simulated WebSocket stream</strong>
    <p id="rust-stream-samples">Samples two demo quotes through a private PHP-to-Rust WebSocket connection. Does not use real broker prices.</p>
  </div>
  <div>
    <button type="button" id="rust-stream-test">Test demo stream</button>
    <output id="rust-stream-result" role="status" aria-live="polite">Not tested</output>
  </div>
</section>
<div id="terminal"><p style="padding:16px">Build chart assets using <code>npm run build</code> in <code>frontend/</code>, then copy <code>dist/chart.js</code> to <code>public/assets/chart.js</code>.</p></div>
<details class="chart-debug">
  <summary>Chart display diagnostics</summary>
  <p>If candles disappear, check canvas rendering and CSP locally. Nothing is transmitted or changed.</p>
  <button type="button" id="chart-diagnose">Diagnose chart</button>
  <button type="button" id="chart-diagnostic-copy" disabled>Copy report</button>
  <button type="button" id="chart-preview-button">Preview painted candle layer</button>
  <pre id="chart-diagnostic-report" role="status">Click Diagnose chart to inspect this browser.</pre>
  <figure id="chart-canvas-preview" class="chart-preview" hidden>
    <img id="chart-canvas-preview-image" alt="Direct PNG rendering of the painted candlestick base canvas, bypassing the chart's overlapping DOM layers.">
    <figcaption>This image is generated entirely in your browser from the base chart canvas. If candles show here but not above, investigate the browser's overlay/compositing layers.</figcaption>
  </figure>
</details>
<p class="note">No live Upstox feed, brokerage login or order execution is enabled. This chart uses deterministic demonstration OHLC data. Market-data source integration is a later phase.</p>
</main>
<script src="/qsyn/assets/chart.js?v=<?= rawurlencode($chartBundleVersion) ?>" defer></script>
<script src="/qsyn/assets/rust-diagnostics.js" defer></script>
<script src="/qsyn/assets/rust-stream-test.js" defer></script>
</body>
</html>

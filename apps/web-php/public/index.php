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
header('Content-Security-Policy: default-src ' . "'self'" . '; script-src ' . "'self'" . '; style-src ' . "'self' 'unsafe-inline'" . '; connect-src ' . "'self'" . '; img-src ' . "'self' data:" . ';');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QSYN — Development Terminal</title>
<style>
html,body{margin:0;background:#0b111b;color:#e5eaf3;font:14px system-ui,sans-serif}
header{padding:18px 24px;border-bottom:1px solid #303b4b;display:flex;align-items:center;gap:14px}
header strong{font-size:19px} .tag{background:#18314a;color:#8cceff;padding:5px 10px;border-radius:6px}
main{padding:20px;max-width:1600px;margin:auto} h1{font-size:20px;font-weight:600}
#terminal{height:min(73vh,800px);min-height:410px;border:1px solid #303b4b;border-radius:9px;overflow:hidden}
.note{color:#a8b9ce;font-size:12px;margin-top:12px;line-height:1.6}
</style>
</head>
<body>
<header><strong>QSYN</strong><span class="tag">Phase 0 · Simulated data</span></header>
<main>
<h1>Chart terminal foundation</h1>
<div id="terminal"><p style="padding:16px">Build chart assets using <code>npm run build</code> in <code>frontend/</code>, then copy <code>dist/chart.js</code> to <code>public/assets/chart.js</code>.</p></div>
<p class="note">No live Upstox feed, brokerage login or order execution is enabled. This chart uses deterministic demonstration OHLC data. Market-data source integration is a later phase.</p>
</main>
<script src="/qsyn/assets/chart.js" defer></script>
</body>
</html>

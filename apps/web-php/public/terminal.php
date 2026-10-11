<?php
declare(strict_types=1);
/*
 * Database-free, read-only terminal shell. Does not initialize broker users,
 * credentials, Flask, private identities, execution or persistence stores.
 * Visual navigation pattern adapted from upstream OpenAlgo (AGPL-3.0).
 */
// Defense in depth: if Cloudways exposes this physical PHP entrypoint
// directly, it MUST NOT bypass the canonical /qsyn/terminal/* auth gate.
// The chart-only /qsyn/ homepage intentionally remains public.
$requestedPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!in_array($requestedPath, ['/', '/qsyn', '/qsyn/'], true)) {
    $src = dirname(__DIR__) . '/src/RustAdmin.php';
    if (!is_file($src)) {
        $src = dirname(__DIR__, 2) . '/private_html/qsyn/app/src/RustAdmin.php';
    }
    if (!is_file($src)) {
        http_response_code(503);
        exit;
    }
    require_once $src;
    if (!\QSYN\Admin\RustAdmin::originAllowed($_SERVER)) {
        http_response_code(403);
        exit;
    }
    \QSYN\Admin\RustAdmin::boot();
    if (!\QSYN\Admin\RustAdmin::authenticated()) {
        header('Cache-Control: no-store');
        header('Location: /qsyn/terminal/login', true, 303);
        exit;
    }
}
$js = __DIR__ . '/assets/terminal.js';
$css = __DIR__ . '/assets/terminal.css';
$jsVersion = (string) (@filemtime($js) ?: '0');
$cssVersion = (string) (@filemtime($css) ?: '0');
?>
<!doctype html>
<html lang="en" data-qsyn-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#10141d">
  <title>QSYN — Trading terminal (Simulated)</title>
  <link rel="stylesheet" href="/qsyn/assets/terminal.css?v=<?= rawurlencode($cssVersion) ?>">
</head>
<body>
  <div id="qsyn-root">
    <p style="padding:24px;font:14px system-ui">QSYN trading terminal · loading simulated workspace…</p>
  </div>
  <noscript>JavaScript is required for this chart terminal.</noscript>
  <script src="/qsyn/assets/terminal.js?v=<?= rawurlencode($jsVersion) ?>" defer></script>
</body>
</html>

<?php
declare(strict_types=1);

// Retired standalone page. Keep this physical PHP entrypoint as a safe
// redirect in case the hosting layer exposes it directly, bypassing the
// main /qsyn/* application router. No private operation is handled here.
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, HEAD');
    header('Cache-Control: private, no-store, max-age=0');
    http_response_code(405);
    exit;
}
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Robots-Tag: noindex, nofollow');
header('Location: /qsyn/terminal?view=operations', true, 302);
exit;

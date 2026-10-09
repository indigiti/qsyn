<?php
declare(strict_types=1);

// Local PHP -S router for the deployed /qsyn/ subpath.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (str_starts_with($path, '/qsyn/assets/')) {
    $asset = __DIR__ . '/public/assets/' . basename($path);
    if (is_file($asset)) {
        header('Content-Type: application/javascript; charset=utf-8');
        readfile($asset);
        return true;
    }
}
require __DIR__ . '/public/index.php';

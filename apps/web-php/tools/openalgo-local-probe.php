<?php
declare(strict_types=1);

// Explicitly operator-run CLI probe of an already isolated, locally installed
// OpenAlgo instance. Never exposed through public index.php or a scheduler.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require_once dirname(__DIR__) . '/src/OpenAlgoLocalProbe.php';

try {
    $mode = $argv[1] ?? '';
    $path = getenv('QSYN_OPENALGO_APIKEY_FILE') ?: '';
    $port = getenv('QSYN_OPENALGO_LOOPBACK_PORT') ?: '5000';
    if (!ctype_digit($port)) {
        throw new RuntimeException('invalid_loopback_port');
    }
    if ($mode === 'quote' && count($argv) === 4) {
        $args = ['symbol' => $argv[2], 'exchange' => $argv[3]];
    } elseif ($mode === 'chain' && count($argv) === 4) {
        $args = [
            'underlying' => $argv[2], 'exchange' => 'NSE_INDEX',
            'expiry_date' => $argv[3], 'strike_count' => 6,
        ];
    } else {
        throw new RuntimeException('usage_quote_SYMBOL_EXCHANGE_or_chain_UNDERLYING_DDMMMYY');
    }
    $output = \QSYN\MarketData\OpenAlgoLocalProbe::request(
        $mode, $args, $path, (int) $port
    );
    echo json_encode($output, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
} catch (Throwable $error) {
    // Do not echo exception detail from providers, API keys, URLs or request bodies.
    fwrite(STDERR, "QSYN provider probe refused or failed; check private operator logs.\n");
    exit(1);
}

<?php
declare(strict_types=1);

require_once __DIR__.'/../src/PersonalIndexGateway.php';

use QSYN\MarketData\PersonalIndexGateway as Gateway;

function ensurePersonal(bool $pass,string $label): void
{
    if (!$pass)throw new RuntimeException($label);
}

if (!function_exists('proc_open') || !defined('PHP_BINARY'))
    throw new RuntimeException('required_php_subprocess_unavailable');

// Reproduce the original failure: Rust exits quickly after emitting 375
// 1-minute candles; PHP must read ALL stdout, not only the first 8192 bytes.
// Fixtures are CLI-only and never substitute for actual production Upstox data.
$fixture=<<<'SOURCE'
$bars=[];
for($i=0;$i<375;$i++){
  $price=25000+$i/10;
  $bars[]=[
    'time'=>1791537300+$i*60,
    'open'=>$price,
    'high'=>$price+2,
    'low'=>$price-2,
    'close'=>$price+1,
    'volume'=>0,
  ];
}
echo json_encode(['schema'=>'QSYN-UPSTOX-RUST-INDEX-HISTORY/1','bars'=>$bars],JSON_THROW_ON_ERROR);
SOURCE;
$invoke=new ReflectionMethod(Gateway::class,'invoke');
$full=$invoke->invoke(null,[PHP_BINARY,'-r',$fixture]);
ensurePersonal(is_array($full),'rust_history_process_output_not_decoded');
ensurePersonal(count($full['bars']??[])===375,'full_375_candles_truncated');
ensurePersonal($full['bars'][0]['time']===1791537300,'opening_candle_missing');
ensurePersonal($full['bars'][374]['close']>25000,'closing_candle_missing');
ensurePersonal(strlen(json_encode($full,JSON_THROW_ON_ERROR))>8192,
    'regression_payload_must_exceed_single_pipe_read');

// Invalid exit status must never pass merely because it emits JSON.
$failed=$invoke->invoke(null,[PHP_BINARY,'-r','echo "{\\\"ok\\\":true}"; exit(2);']);
ensurePersonal($failed===null,'failed_rust_process_accepted');

// Unbounded Rust stdout must fail closed and not leak process output.
$oversize=$invoke->invoke(null,[PHP_BINARY,'-r',
    'echo json_encode(["bars"=>str_repeat("A",115000)]);']);
ensurePersonal($oversize===null,'oversized_rust_history_accepted');

echo "PASS personal Rust index history: full-day stdout, process failures and output bounds\n";

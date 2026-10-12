<?php
declare(strict_types=1);
/** Offline positive data-path regression. No simulated market source in production. */
require dirname(__DIR__).'/src/UpstoxIndexV3.php';
require dirname(__DIR__).'/src/IndexHistoricalProof.php';
use QSYN\MarketData\IndexHistoricalProof as Proof;

$tz=new DateTimeZone('Asia/Kolkata');
$date=(new DateTimeImmutable('now',$tz))->setTime(0,0)->modify('-1 day');
while ((int)$date->format('N')>5) $date=$date->modify('-1 day');
$day=$date->format('Y-m-d');
$one=$day.'T09:15:00+05:30';
$two=$day.'T09:16:00+05:30';
$mock=[
    'http_status'=>200,'body'=>[
        'status'=>'success','data'=>['candles'=>[
            [$two,25001.5,25012.0,24995.0,25008.0,0],
            [$one,24990.0,25005.0,24984.0,25001.5,0],
        ]]
    ]
];
$r=Proof::summarize('NIFTY',$day,$mock);
if (($r['code']??'')!=='UPSTOX_HISTORY_CANDLES_VERIFIED'
    || ($r['candle_count']??null)!==2 || ($r['history_verified']??null)!==true
    || ($r['display_rights_verified']??true)!==false
    || ($r['live_feed_verified']??true)!==false
    || ($r['trading_enabled']??true)!==false
    || empty($r['first_candle_utc']) || empty($r['last_candle_utc'])
    || $r['first_candle_utc'] >= $r['last_candle_utc'])
    throw new RuntimeException('valid_provider_candles_not_verified');
$json=json_encode($r,JSON_THROW_ON_ERROR);
if (str_contains($json,'25001.5') || str_contains($json,'access_token')
    || str_contains($json,'candles":['))
    throw new RuntimeException('raw_price_or_secret_exposed');
$auth=Proof::summarize('SENSEX',$day,['http_status'=>401,
    'body'=>['errors'=>['PRIVATE_PROVIDER_ACCOUNT_DATA']]]);
if (($auth['code']??'')!=='UPSTOX_HISTORY_AUTH_DENIED'
    || str_contains(json_encode($auth),'PRIVATE_PROVIDER_ACCOUNT_DATA'))
    throw new RuntimeException('provider_error_leaked');
$empty=Proof::summarize('NIFTY',$day,['http_status'=>200,
    'body'=>['status'=>'success','data'=>['candles'=>[]]]]);
if ($empty['code']!=='UPSTOX_HISTORY_NO_CANDLES' || $empty['history_verified'])
    throw new RuntimeException('empty_provider_response_marked_ready');
try {
    Proof::summarize('NIFTY',$day,['http_status'=>200,
        'body'=>['status'=>'success','data'=>['candles'=>[
            [$one,100,50,90,101,0]
        ]]]]);
    throw new RuntimeException('invalid_ohlc_accepted');
} catch (RuntimeException $e) {
    if ($e->getMessage()==='invalid_ohlc_accepted') throw $e;
}
try {
    Proof::summarize('NSE_FO',$day,$mock);
    throw new RuntimeException('unknown_symbol_accepted');
} catch (InvalidArgumentException) {}
echo "PASS core history proof: genuine Upstox candle contract, 401/empty/invalid and zero OHLC disclosure\n";

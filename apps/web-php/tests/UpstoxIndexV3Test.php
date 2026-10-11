<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/UpstoxIndexV3.php';

use QSYN\MarketData\UpstoxIndexV3;

function assertTrue(bool $condition, string $why): void {
    if (!$condition) throw new RuntimeException($why);
}
function expectReject(callable $fn,string $why): void {
    try { $fn(); } catch (RuntimeException) { return; }
    throw new RuntimeException($why);
}
$asof=(new DateTimeImmutable('2026-10-11T12:00:00+00:00'))->getTimestamp();
$upstox=[
    'status'=>'success',
    'data'=>['candles'=>[
        ['2026-10-09T10:15:00+05:30',25610.5,25620.0,25600.0,25615.0,0,0],
        ['2026-10-09T09:15:00+05:30',25590.0,25610.0,25585.0,25605.0,0,0],
    ]],
];
$bars=UpstoxIndexV3::normalize($upstox,'1h',$asof);
assertTrue(count($bars)===2,'two_real_index_bars');
assertTrue($bars[0]['time']<(int)$bars[1]['time'],'ascending_exchange_epoch_seconds');
assertTrue($bars[0]['time']%3600!==0,'nse_hourly_candles_not_utc_hour_aligned');
assertTrue($bars[0]['volume']===0.0,'nontraded_index_volume_may_be_zero');
assertTrue($bars[1]['close']===25615.0,'close_price_preserved');

$contract=UpstoxIndexV3::accountScopedPayload(
    'upstox-account-01','NSE_INDEX','NIFTY','1h',$upstox,$asof
);
assertTrue($contract['schema']==='QSYN-LICENSED-INDIA-INDEX-BARS/1','schema');
assertTrue($contract['account_scoped']===true,'account_scope_required');
assertTrue($contract['public_redistribution_allowed']===false,'not_public');
assertTrue($contract['trading_enabled']===false,'never_enable_trading');
assertTrue($contract['source']==='licensed_broker_index','no_simulation');
assertTrue(count($contract['bars'])===2,'payload_bars');

$daily=['status'=>'success','data'=>['candles'=>[
    ['2026-10-09T00:00:00+05:30',25000,26000,24800,25500,0],
]]];
$d=UpstoxIndexV3::normalize($daily,'1d',$asof);
assertTrue(count($d)===1 && $d[0]['time']%86400!==0,'india_daily_not_utc_midnight');
assertTrue(UpstoxIndexV3::intradayPath(
    'NSE_INDEX','NIFTY','NSE_INDEX|Nifty 50','1m'
)==='/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/1',
    'fixed_host_independent_provider_path');

foreach ([
    ['BSE_INDEX','NIFTY','BSE_INDEX|SENSEX','1m'],
    ['NSE_INDEX','NIFTY','BSE_INDEX|SENSEX','1m'],
    ['NSE_INDEX','NIFTY','NSE_INDEX|../secret','1m'],
    ['NSE_INDEX','NIFTY','NSE_INDEX|Nifty 50','2m'],
] as $input) {
    expectReject(fn()=>UpstoxIndexV3::intradayPath(...$input),'bad_index_path_accepted');
}
$bad=$upstox;
$bad['data']['candles'][0][3]=30000;
expectReject(fn()=>UpstoxIndexV3::normalize($bad,'1h',$asof),'invalid_low_accepted');
$dup=$upstox;
$dup['data']['candles'][]=$dup['data']['candles'][0];
expectReject(fn()=>UpstoxIndexV3::normalize($dup,'1h',$asof),'duplicate_accepted');
$invalidDay=$daily;
$invalidDay['data']['candles'][0][0]='2026-10-09T00:00:00+00:00';
expectReject(fn()=>UpstoxIndexV3::normalize($invalidDay,'1d',$asof),'wrong_timezone_accepted');
expectReject(fn()=>UpstoxIndexV3::normalize(['status'=>'error'],'1m',$asof),'bad_upstream_accepted');
expectReject(fn()=>UpstoxIndexV3::accountScopedPayload(
    '../secret','NSE_INDEX','NIFTY','1m',$upstox,$asof),'bad_account_accepted');
echo "PASS: Upstox V3 NSE/BSE candle normalization, IST alignment and strictly licensed account contract\n";

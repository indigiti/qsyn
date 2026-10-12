<?php
declare(strict_types=1);
require_once __DIR__.'/../src/RustAdmin.php';
require_once __DIR__.'/../src/NativeUpstoxAnalyticsApi.php';
require_once __DIR__.'/../src/NativeUpstoxIndexCandles.php';
use QSYN\MarketData\NativeUpstoxIndexCandles as Index;

function check(bool $pass,string $case):void {
    if(!$pass)throw new RuntimeException('index_read_test_failed:'.$case);
}
$names=[
    'NIFTY'=>['NSE_INDEX','NSE','Nifty 50'],
    'BANKNIFTY'=>['NSE_INDEX','NSE','Nifty Bank'],
    'FINNIFTY'=>['NSE_INDEX','NSE','Nifty Fin Service'],
    'MIDCPNIFTY'=>['NSE_INDEX','NSE','Nifty Mid Select'],
    'INDIAVIX'=>['NSE_INDEX','NSE','India VIX'],
    'SENSEX'=>['BSE_INDEX','BSE','SENSEX'],
];
foreach($names as $alias=>[$venue,$exchange,$name]){
    $key=$venue.'|'.$name;
    $search=['status'=>'success','data'=>[
        ['segment'=>$venue,'exchange'=>$exchange,
            'instrument_type'=>'INDEX','instrument_key'=>$key,
            'name'=>$name,'trading_symbol'=>$name],
        ['segment'=>'NSE_FO','exchange'=>'NSE',
            'instrument_type'=>'FUT','instrument_key'=>'NSE_FO|123',
            'name'=>$name],
    ]];
    check(Index::resolveIndex($alias,$search)===$key,$alias.'_exact');
    $wrong=$search;$wrong['data'][0]['segment']='NSE_FO';
    check(Index::resolveIndex($alias,$wrong)===null,$alias.'_wrong_venue');
    $wrong=$search;$wrong['data'][0]['name']='Some Other Index';
    $wrong['data'][0]['trading_symbol']='Other';
    $wrong['data'][0]['instrument_key']=$venue.'|Other';
    check(Index::resolveIndex($alias,$wrong)===null,$alias.'_wrong_index');
    $provider=function(string $url,string $token)use($search,$key):array{
        check($token==='fixture-read-only-token','server_bearer');
        if(str_contains($url,'/v2/instruments/search')){
            check(str_contains($url,'segments=INDEX'),'index_only_search');
            return [200,$search];
        }
        check(str_contains($url,rawurlencode($key)),'resolved_key_not_browser');
        if(str_contains($url,'/intraday/'))return [200,[
            'status'=>'success','data'=>['candles'=>[
                ['2026-10-12T09:16:00+05:30',100.2,101.3,99.8,100.9,0,0],
                ['2026-10-12T09:15:00+05:30',100.1,101.0,99.9,100.2,0,0]
            ]]
        ]];
        return [200,['status'=>'success','data'=>['candles'=>[
            ['2026-10-09T15:29:00+05:30',99.3,99.5,99.1,99.2,0,0]
        ]]]];
    };
    [$code,$data]=Index::read($alias,'1m',300,$provider,'fixture-read-only-token');
    check($code===200,$alias.'_status');
    check($data['schema']==='QSYN-UPSTOX-ADMIN-INDEX-CANDLES/1',$alias.'_schema');
    check($data['count']===3,$alias.'_3_actual_provider_candles');
    check($data['bars'][0]['close']===99.2,$alias.'_exact_provider_ohlc');
    check($data['bars'][1]['time']<$data['bars'][2]['time'],$alias.'_time_order');
    check($data['live_socket_verified']===false && $data['trading_enabled']===false
        && $data['public_redistribution_allowed']===false,$alias.'_no_live_inference');
}
check(Index::resolveIndex('NO_SUCH_INDEX',['status'=>'success','data'=>[]])===null,'unknown_alias');
[$code,$data]=Index::read('NO_SUCH_INDEX','1m',300,static fn()=>[200,[]],'token');
check($code===422,'unknown_alias_rejected');
[$code,$data]=Index::read('NIFTY','7m',300,static fn()=>[200,[]],'token');
check($code===422,'unknown_interval_rejected');
$bad=['status'=>'success','data'=>['candles'=>[
  ['2026-10-12T09:15:00+05:30',100,101,102,103,0]
]]];
check(Index::parseCandles($bad,60,300,time())===null,'invalid_high_low');
$bad['data']['candles'][0][3]=99;
check(Index::parseCandles($bad,60,300,time())!==null,'corrected_low_valid');
$bad['data']['candles'][0][4]=102;
check(Index::parseCandles($bad,60,300,time())===null,'invalid_close_exceeds_high');
echo "PASS index history: six exact Upstox instruments, genuine OHLC, strict venue matching, denied scope, non-trading provenance\n";

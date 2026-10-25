<?php
declare(strict_types=1);
require_once __DIR__.'/../src/UpstoxInstrumentSearch.php';
require_once __DIR__.'/../src/UpstoxMasterCatalog.php';
use QSYN\MarketData\UpstoxMasterCatalog as Master;

function checkMaster(bool $ok,string $message): void {
    if(!$ok)throw new RuntimeException($message);
}
$invalid=[
    ['exchange'=>'MCX'],['exchange'=>'NSE','segment'=>'BSE_EQ'],
    ['exchange'=>'NSE','query'=>'<script>'],['exchange'=>'BSE','page'=>'0'],
    ['exchange'=>'NSE','type'=>'BOGUS'],['exchange'=>'NSE','url'=>'https://bad'],
    ['exchange'=>'NSE','records'=>'100'],['exchange'=>'BSE','query'=>['NIFTY']],
];
foreach($invalid as $case)checkMaster(Master::validate($case)===null,'accepted_invalid_'.json_encode($case));
$params=Master::validate(['exchange'=>'NSE','segment'=>'EQ','query'=>'reliance']);
checkMaster($params!==null&&$params['records']===20,'valid_params_rejected');

$root=sys_get_temp_dir().'/qsyn-master-'.bin2hex(random_bytes(6));
$generation='bod-2026-10-25-aaaaaaaaaaaa';
mkdir($root,0700);mkdir($root.'/upstox-master',0700);mkdir($root.'/upstox-master/'.$generation,0700);
try {
    $nse=[
        ['instrument_key'=>'NSE_EQ|INE002A01018','exchange'=>'NSE','segment'=>'NSE_EQ',
         'trading_symbol'=>'RELIANCE','name'=>'RELIANCE INDUSTRIES','instrument_type'=>'EQ'],
        ['instrument_key'=>'NSE_EQ|INE123456789','exchange'=>'NSE','segment'=>'NSE_EQ',
         'trading_symbol'=>'TCS','name'=>'TATA CONSULTANCY','instrument_type'=>'EQ'],
        ['instrument_key'=>'NSE_FO|123','exchange'=>'NSE','segment'=>'NSE_FO',
         'trading_symbol'=>'NIFTY 25000 CE','name'=>'NIFTY','instrument_type'=>'CE'],
        ['instrument_key'=>'NSE_INDEX|Nifty 50','exchange'=>'NSE','segment'=>'NSE_INDEX',
         'trading_symbol'=>'NIFTY 50','name'=>'NIFTY 50','instrument_type'=>'INDEX'],
    ];
    $bse=[['instrument_key'=>'BSE_EQ|INE002A01018','exchange'=>'BSE','segment'=>'BSE_EQ',
           'trading_symbol'=>'RELIANCE','name'=>'RELIANCE','instrument_type'=>'EQ']];
    foreach(['NSE'=>$nse,'BSE'=>$bse] as $exchange=>$rows) {
        $path=$root.'/upstox-master/'.$generation.'/'.$exchange.'.ndjson';
        file_put_contents($path,implode("\n",array_map('json_encode',$rows))."\n");
        chmod($path,0600);
    }
    $manifest=[
      'schema'=>'QSYN-UPSTOX-BOD-MASTER/1','generation'=>$generation,
      'imported_day_ist'=>'2026-10-25','data_state'=>'discovery_only',
      'trading_enabled'=>false,'history_verified'=>false,'live_feed_verified'=>false,
      'exchanges'=>['NSE'=>['total'=>count($nse)],'BSE'=>['total'=>count($bse)]]
    ];
    $current=$root.'/upstox-master/current.json';
    file_put_contents($current,json_encode($manifest));chmod($current,0600);
    checkMaster(Master::status($root)['catalog_ready']===true,'master_not_ready');
    checkMaster(Master::status($root)['exchange_counts']['NSE']===4,'master_counts_wrong');

    [$code,$found]=Master::search($root,$params,'fixture-secret','session-fixture',100);
    checkMaster($code===200&&$found['total_records']===1,'NSE_equity_search_incomplete');
    checkMaster(($found['instruments'][0]['instrument_key']??'')==='NSE_EQ|INE002A01018','equity_key_lost');
    checkMaster(!empty($found['instruments'][0]['selection_scope']),'chart_scope_missing');
    checkMaster($found['history_verified']===false&&$found['live_feed_verified']===false
        &&$found['trading_enabled']===false,'master_falsely_granted_data_rights');
    [$code,$found]=Master::search($root,Master::validate(['exchange'=>'NSE','segment'=>'FO']));
    checkMaster($code===200&&$found['total_records']===1,'derivatives_missing');
    checkMaster($found['instruments'][0]['selection_scope']===null,'token_free_scope');
    [$code,$found]=Master::search($root,Master::validate(['exchange'=>'NSE','segment'=>'ALL','records'=>'1','page'=>'2']));
    checkMaster($code===200&&$found['total_records']===4
      &&$found['instruments'][0]['trading_symbol']==='TCS','pagination_missing');
    [$code,$found]=Master::search($root,Master::validate(['exchange'=>'BSE','segment'=>'EQ']));
    checkMaster($code===200&&$found['total_records']===1
      &&$found['instruments'][0]['exchange']==='BSE','exchange_leakage');
    // Fail closed on incomplete cache or unsafe permissions.
    file_put_contents($root.'/upstox-master/'.$generation.'/BSE.ndjson','');
    [$code,$payload]=Master::search($root,Master::validate(['exchange'=>'BSE']));
    checkMaster($code===409,'truncated_exchange_accepted');
    chmod($root.'/upstox-master/current.json',0644);
    checkMaster(Master::status($root)['catalog_ready']===false,'world_readable_cache_accepted');
    echo "PASS: private NSE/BSE BOD master catalog filtering, pagination, scope and fail-closed files\n";
} finally {
    foreach(glob($root.'/upstox-master/'.$generation.'/*')?:[] as $f)unlink($f);
    @rmdir($root.'/upstox-master/'.$generation);
    @unlink($root.'/upstox-master/current.json');
    @rmdir($root.'/upstox-master');@rmdir($root);
}

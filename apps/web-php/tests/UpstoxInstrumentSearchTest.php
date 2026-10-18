<?php
declare(strict_types=1);
require_once __DIR__.'/../src/UpstoxInstrumentSearch.php';
use QSYN\MarketData\UpstoxInstrumentSearch as Search;
function ensureInstrument(bool $ok,string $label): void {
    if (!$ok) throw new RuntimeException($label);
}
$params=Search::validate([
    'query'=>'NIFTY 25000 CE','exchanges'=>'NSE,BSE','segments'=>'FO',
    'instrument_types'=>'CE','expiry'=>'current_week',
    'page_number'=>'2','records'=>'20'
]);
ensureInstrument(is_array($params),'valid_search_rejected');
ensureInstrument($params['page_number']===2,'page_lost');
ensureInstrument($params['expiry']==='current_week','expiry_lost');
foreach([
    ['query'=>'N'],['query'=>'<script>'],['query'=>'https://evil'],
    ['query'=>'NIFTY','records'=>'100'],
    ['query'=>'NIFTY','page_number'=>'0'],
    ['query'=>'NIFTY','atm_offset'=>'500'],
    ['query'=>'NIFTY','expiry'=>'2026-02-30'],
    ['query'=>'NIFTY','exchanges'=>'NSE,INVALID'],
    ['query'=>'NIFTY','url'=>'https://bad.example'],
    ['query'=>['NIFTY']],
] as $input) ensureInstrument(Search::validate($input)===null,
    'unsafe_search_accepted_'.json_encode($input));
$body=[
 'status'=>'success',
 'data'=>[[
   'instrument_key'=>'NSE_FO|157318','name'=>'RELIANCE INDUSTRIES LTD',
   'trading_symbol'=>'RELIANCE 1380 CE 30 MAR 26','exchange'=>'NSE',
   'segment'=>'NSE_FO','expiry'=>'2026-03-30','instrument_type'=>'CE',
   'strike_price'=>1380.0,'lot_size'=>500,
   'access_token'=>'SHOULD_NOT_LEAK','last_price'=>9999
 ]],
 'meta_data'=>['page'=>['total_pages'=>3,'total_records'=>44]],
 'access_token'=>'SHOULD_NOT_LEAK'
];
$data=Search::normalize($body,$params);
ensureInstrument(is_array($data),'valid_instrument_result_rejected');
ensureInstrument($data['source']==='upstox_instrument_search_v2','wrong_source');
ensureInstrument($data['history_verified']===false&&$data['live_feed_verified']===false,
    'symbol_search_falsely_verified_data');
ensureInstrument(count($data['instruments'])===1,'instrument_lost');
ensureInstrument($data['instruments'][0]['instrument_key']==='NSE_FO|157318',
    'stable_instrument_key_not_returned');
ensureInstrument(!str_contains(json_encode($data),'SHOULD_NOT_LEAK'),'upstream_sensitive_fields_leaked');
ensureInstrument(Search::normalize(['status'=>'success','data'=>array_fill(0,31,$body['data'][0])],$params)===null,
    'unbounded_search_accepted');
ensureInstrument(Search::normalize(['status'=>'error','data'=>[]],$params)===null,
    'provider_error_treated_as_no_results');
echo "PASS Upstox read-only instrument search: scope, pagination, sanitization, no invented quotes\n";

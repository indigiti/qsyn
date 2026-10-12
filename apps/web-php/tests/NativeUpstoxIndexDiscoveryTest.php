<?php
declare(strict_types=1);

/**
 * Pure mocked Upstox provider regression: no network, broker credentials or
 * trading. Validates seven bounded server-built INDEX searches and safe results.
 */
require dirname(__DIR__).'/src/NativeUpstoxProfileVerifier.php';
require dirname(__DIR__).'/src/NativeUpstoxAnalyticsApi.php';
require dirname(__DIR__).'/src/NativeUpstoxIndexDiscovery.php';

use QSYN\Broker\NativeUpstoxIndexDiscovery as Discovery;

$private = sys_get_temp_dir().'/qsyn-index-discover-'.bin2hex(random_bytes(8));
if (!mkdir($private,0700)) throw new RuntimeException('test_private_directory');
$file=$private.'/upstox-session.json';
$token=str_repeat('T',80);
$session=[
    'schema'=>'QSYN-UPSTOX-AUTH-SESSION/1',
    'broker'=>'upstox','user_id'=>'TEST_UPSTOX',
    'access_token'=>$token,'created_at'=>gmdate('c'),
    'order_routing_enabled'=>false,
    'display_entitlement_verified'=>false,
    'retention_entitlement_verified'=>false,
];
file_put_contents($file,json_encode($session,JSON_THROW_ON_ERROR));
chmod($file,0600);

$rows=[
    'Nifty 50'=>['NSE_INDEX','NSE','NIFTY','Nifty 50','NSE_INDEX|Nifty 50'],
    'Nifty Bank'=>['NSE_INDEX','NSE','BANKNIFTY','Nifty Bank','NSE_INDEX|Nifty Bank'],
    'Nifty Fin Service'=>['NSE_INDEX','NSE','FINNIFTY','Nifty Fin Service','NSE_INDEX|Nifty Fin Service'],
    'Nifty Mid Select'=>['NSE_INDEX','NSE','MIDCPNIFTY','Nifty Mid Select','NSE_INDEX|Nifty Mid Select'],
    'India VIX'=>['NSE_INDEX','NSE','INDIA VIX','India VIX','NSE_INDEX|India VIX'],
    'SENSEX'=>['BSE_INDEX','BSE','SENSEX','SENSEX','BSE_INDEX|SENSEX'],
    'BANKEX'=>['BSE_INDEX','BSE','BANKEX','BANKEX','BSE_INDEX|BANKEX'],
];
$calls=[];
$mock=static function(string $url,string $bearer) use ($token,$rows,&$calls):array {
    if ($bearer!==$token) throw new RuntimeException('unexpected_token');
    $calls[]=$url;
    if ($url==='https://api.upstox.com/v2/user/profile') {
        return ['http_status'=>200,'body'=>['status'=>'success','data'=>[
            'user_id'=>'TEST_UPSTOX','is_active'=>true,
        ]]];
    }
    $p=parse_url($url);
    if (($p['scheme']??null)!=='https' || ($p['host']??null)!=='api.upstox.com'
        || ($p['path']??null)!=='/v2/instruments/search') {
        throw new RuntimeException('untrusted_search_url');
    }
    parse_str($p['query']??'', $params);
    if (($params['segments']??null)!=='INDEX'
        || ($params['records']??null)!=='30'
        || ($params['page_number']??null)!=='1'
        || !isset($rows[$params['query']??''])) {
        throw new RuntimeException('broad_or_user_supplied_query');
    }
    [$segment,$exchange,$trading,$name,$key]=$rows[$params['query']];
    if (($params['exchanges']??null)!==$exchange) {
        throw new RuntimeException('wrong_exchange_filter');
    }
    return ['http_status'=>200,'body'=>[
        'status'=>'success',
        'data'=>[
            ['segment'=>'NSE_FO','exchange'=>'NSE','instrument_type'=>'CE',
             'trading_symbol'=>'NIFTY','instrument_key'=>'NSE_FO|999'],
            ['segment'=>$segment,'exchange'=>$exchange,'instrument_type'=>'INDEX',
             'trading_symbol'=>$trading,'name'=>$name,'instrument_key'=>$key],
        ],
        'meta_data'=>['page'=>['page_number'=>1,'total_pages'=>1]],
    ]];
};
try {
    $r=Discovery::discover($private,'TEST_UPSTOX',$mock);
    if ($r['status']!=='resolved_for_review'
        || $r['mapping_fully_resolved']!==true
        || $r['session_verified_now']!==true
        || $r['current_bod_attested']!==false
        || $r['exchange_display_entitlement_verified']!==false
        || $r['index_feed_activated']!==false
        || $r['trading_enabled']!==false
        || count($r['instruments'])!==7
        || count($calls)!==8) {
        throw new RuntimeException('unexpected_discovery_state:'.json_encode($r));
    }
    $json=json_encode($r,JSON_THROW_ON_ERROR);
    if (str_contains($json,$token) || str_contains($json,'TEST_UPSTOX')
        || str_contains($json,'access_token')
        || !str_contains($json,'NSE_INDEX|Nifty 50')) {
        throw new RuntimeException('report_not_sanitized');
    }

    $expired=static fn($url,$bearer)=>[
        'http_status'=>401,'body'=>['status'=>'error','errors'=>['SECRET_PROVIDER_ERROR']],
    ];
    $r=Discovery::discover($private,'TEST_UPSTOX',$expired);
    if ($r['session_verified_now']!==false
        || $r['mapping_fully_resolved']!==false || $r['instruments']!==[]) {
        throw new RuntimeException('expired_profile_accepted');
    }
    $missing=Discovery::discover($private,'DIFFERENT_ACCOUNT',$mock);
    if ($missing['mapping_fully_resolved']!==false) {
        throw new RuntimeException('foreign_profile_accepted');
    }
    $ambiguous=static function($url,$bearer) use ($mock) {
        $resp=$mock($url,$bearer);
        if (str_contains($url,'query=Nifty%2050&')) {
            $resp['body']['data'][]=[
                'segment'=>'NSE_INDEX','exchange'=>'NSE','instrument_type'=>'INDEX',
                'trading_symbol'=>'NIFTY',
                'instrument_key'=>'NSE_INDEX|Another Nifty Alias',
            ];
        }
        return $resp;
    };
    $r=Discovery::discover($private,'TEST_UPSTOX',$ambiguous);
    if ($r['mapping_fully_resolved']!==false
        || $r['instruments'][0]['status']!=='ambiguous'
        || $r['instruments'][0]['instrument_key']!==null) {
        throw new RuntimeException('ambiguous_index_key_accepted');
    }
    $multipage=static function($url,$bearer) use ($mock) {
        $resp=$mock($url,$bearer);
        if (str_contains($url,'query=Nifty%2050&')) {
            $resp['body']['meta_data']['page']['total_pages']=2;
        }
        return $resp;
    };
    $r=Discovery::discover($private,'TEST_UPSTOX',$multipage);
    if ($r['mapping_fully_resolved']!==false
        || $r['instruments'][0]['status']!=='pagination_incomplete') {
        throw new RuntimeException('multi_page_index_accepted');
    }
    chmod($file,0644);
    $r=Discovery::discover($private,'TEST_UPSTOX',$mock);
    if ($r['mapping_fully_resolved']!==false) {
        throw new RuntimeException('unsafe_oauth_file_accepted');
    }
    // Real-world gap: a valid Analytics Token may exist without a usable
    // daily OAuth profile session. Its read-only V3 feed authorization is
    // enough for instrument lookup, NOT provider account verification.
    chmod($file,0600);
    unlink($file);
    $analyticsFile=$private.'/upstox-analytics-session.json';
    $analyticsSession=$session;
    $analyticsSession['schema']='QSYN-UPSTOX-ANALYTICS-SESSION/1';
    file_put_contents($analyticsFile,json_encode($analyticsSession,JSON_THROW_ON_ERROR));
    chmod($analyticsFile,0600);
    $analyticsCalls=0;
    $auth=static function(string $bearer) use ($token,&$analyticsCalls):bool {
        ++$analyticsCalls;
        return hash_equals($token,$bearer);
    };
    $calls=[];
    $r=Discovery::discover($private,'TEST_UPSTOX',$mock,$auth);
    if ($r['status']!=='resolved_for_review'
        || $r['mapping_fully_resolved']!==true
        || $r['credential_source']!=='analytics_read_only'
        || $r['market_data_token_authorized_now']!==true
        || $r['session_verified_now']!==false
        || $r['account_identity_verified_by_analytics']!==false
        || $r['current_bod_attested']!==false
        || $r['exchange_display_entitlement_verified']!==false
        || $r['index_feed_activated']!==false
        || count($r['instruments'])!==6
        || count($calls)!==7 || $analyticsCalls!==1) {
        throw new RuntimeException('analytics_discovery_not_safe:'.json_encode($r));
    }
    $serialized=json_encode($r,JSON_THROW_ON_ERROR);
    if (str_contains($serialized,$token)
        || str_contains($serialized,'TEST_UPSTOX')
        || str_contains($serialized,'access_token')) {
        throw new RuntimeException('analytics_discovery_leaked_credentials');
    }
    $calls=[];
    $denied=Discovery::discover($private,'TEST_UPSTOX',$mock,
        static fn(string $bearer):bool=>false);
    if ($denied['mapping_fully_resolved']!==false || $calls!==[]
        || $denied['code']!=='UPSTOX_ANALYTICS_MARKET_AUTH_UNAVAILABLE') {
        throw new RuntimeException('revoked_analytics_allowed_search');
    }
    $calls=[];
    $foreign=Discovery::discover($private,'OTHER_USER',$mock,$auth);
    if ($foreign['mapping_fully_resolved']!==false || $calls!==[]) {
        throw new RuntimeException('foreign_analytics_user_accepted');
    }
    chmod($analyticsFile,0644);
    $calls=[];
    $unsafe=Discovery::discover($private,'TEST_UPSTOX',$mock,$auth);
    if ($unsafe['mapping_fully_resolved']!==false || $calls!==[]) {
        throw new RuntimeException('unsafe_analytics_file_accepted');
    }
    chmod($analyticsFile,0600);
    unlink($analyticsFile);
    echo "PASS Upstox authenticated fixed-host index search, OAuth and Analytics seven strict matches, reject ambiguity/pagination/token leak and unlicensed feed\n";
} finally {
    if (is_file($file)) unlink($file);
    rmdir($private);
}

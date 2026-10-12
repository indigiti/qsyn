<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/IndiaIndexCatalog.php';

use QSYN\MarketData\IndiaIndexCatalog;

function check(bool $ok, string $name): void
{
    if (!$ok) throw new RuntimeException($name);
}

[$code, $list] = IndiaIndexCatalog::dispatch('indexes', [], ['REQUEST_METHOD'=>'GET']);
check($code === 200, 'catalog_get');
check(($list['schema'] ?? '') === 'QSYN-INDIA-INDEX-CATALOG/1', 'schema');
check(($list['live_data_available'] ?? true) === false, 'not_licensed');
check(($list['public_redistribution_allowed'] ?? true) === false, 'not_public');
check(($list['trading_enabled'] ?? true) === false, 'trading_off');
$keys=array_map(static fn (array $x): string => $x['exchange'] . ':' . $x['symbol'], $list['indexes']);
check(count($keys)===7 && count(array_unique($keys))===7, 'seven_distinct_indexes');
foreach (['NSE_INDEX:NIFTY','NSE_INDEX:BANKNIFTY','NSE_INDEX:FINNIFTY',
  'NSE_INDEX:MIDCPNIFTY','BSE_INDEX:SENSEX','BSE_INDEX:BANKEX','NSE_INDEX:INDIAVIX'] as $key) {
    check(in_array($key,$keys,true),'missing_index_' . $key);
}
[$code,$closed]=IndiaIndexCatalog::dispatch('bars',[
    'exchange'=>'NSE_INDEX','symbol'=>'NIFTY','interval'=>'1m','limit'=>'300',
],['REQUEST_METHOD'=>'GET']);
check($code===503 && ($closed['error']??'')==='india_index_feed_not_authorized','fail_closed');

foreach ([
  ['exchange'=>'NSE_FO','symbol'=>'NIFTY','interval'=>'1m','limit'=>'300'],
  ['exchange'=>'NSE_INDEX','symbol'=>'../../etc','interval'=>'1m','limit'=>'300'],
  ['exchange'=>'NSE_INDEX','symbol'=>'NIFTY','interval'=>'2m','limit'=>'300'],
  ['exchange'=>'NSE_INDEX','symbol'=>'NIFTY','interval'=>'1m','limit'=>'1000'],
  ['exchange'=>'BSE_INDEX','symbol'=>'NIFTY','interval'=>'1m','limit'=>'300'],
  ['exchange'=>['NSE_INDEX'],'symbol'=>'NIFTY','interval'=>'1m','limit'=>'300'],
] as $query) {
    [$status]=IndiaIndexCatalog::dispatch('bars',$query,['REQUEST_METHOD'=>'GET']);
    check($status===422,'invalid_index_did_not_fail');
}
[$status]=IndiaIndexCatalog::dispatch('bars',[],['REQUEST_METHOD'=>'POST']);
check($status===405,'read_only');
echo "PASS: Seven Indian index aliases, source licensing and fail-closed market data route\n";

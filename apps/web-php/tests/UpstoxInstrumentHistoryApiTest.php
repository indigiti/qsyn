<?php
declare(strict_types=1);
require_once __DIR__.'/../src/UpstoxInstrumentSearch.php';
require_once __DIR__.'/../src/UpstoxInstrumentHistoryApi.php';
use QSYN\MarketData\UpstoxInstrumentHistoryApi as History;
use QSYN\MarketData\UpstoxInstrumentSearch as Search;
function ensureUpstoxHistory(bool $pass,string $name):void{
    if(!$pass)throw new RuntimeException($name);
}
ensureUpstoxHistory(History::validDay('2022-01-03'),'valid_date_rejected');
ensureUpstoxHistory(!History::validDay('2021-12-31'),'before_provider_range');
ensureUpstoxHistory(!History::validDay('2026-02-30'),'invalid_date');
ensureUpstoxHistory(!History::validDay('2099-01-01'),'future_date');
ensureUpstoxHistory(!History::validDay(['2026-10-09']),'array_date');
$scope=Search::signScope('NSE_EQ|INE002A01018','unit-broker','admin-csrf',1000);
ensureUpstoxHistory(is_string($scope),'equity_scope_unavailable');
ensureUpstoxHistory(Search::verifyScope($scope,'unit-broker','admin-csrf',1100)
    ==='NSE_EQ|INE002A01018','equity_scope_not_verified');
ensureUpstoxHistory(Search::verifyScope($scope,'unit-broker','admin-csrf',1600)
    ===null,'expired_selection_accepted');
ensureUpstoxHistory(Search::verifyScope($scope,'unit-broker','other-admin',1100)
    ===null,'foreign_browser_selection_accepted');
ensureUpstoxHistory(Search::signScope('NSE_FO|123?url=evil','unit-broker','admin-csrf',1000)
    ===null,'untrusted_key_signed');
echo "PASS signed Upstox historical selection, bounded dates and account isolation\n";

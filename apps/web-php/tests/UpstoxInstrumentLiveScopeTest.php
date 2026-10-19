<?php
declare(strict_types=1);
require_once __DIR__.'/../src/UpstoxInstrumentHistoryApi.php';
require_once __DIR__.'/../src/UpstoxInstrumentSearch.php';
use QSYN\MarketData\UpstoxInstrumentSearch as Search;
function checked(bool $good,string $label):void{
 if(!$good)throw new RuntimeException($label);
}
$scope=Search::signScope('NSE_FO|157318','private-token-fixture','admin-csrf',100);
checked(is_string($scope),'signed_discovery_scope');
checked(Search::verifyScope($scope,'private-token-fixture','admin-csrf',200)
    ==='NSE_FO|157318','scope_verified_same_user');
checked(Search::verifyScope($scope,'different-token','admin-csrf',200)
    ===null,'cross_account_scope_rejected');
checked(Search::verifyScope($scope,'private-token-fixture','different-session',200)
    ===null,'cross_session_scope_rejected');
checked(Search::verifyScope($scope,'private-token-fixture','admin-csrf',701)
    ===null,'expired_scope_rejected');
echo "PASS single instrument live selection stays bound to authorized discovery session\n";

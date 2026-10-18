<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/TerminalRoutes.php';

use QSYN\Routing\TerminalRoutes;
function check(bool $value,string $message): void {
    if (!$value) throw new RuntimeException('terminal_routes_test:' . $message);
}
$registry=new TerminalRoutes(dirname(__DIR__) . '/public/terminal-routes.json');
$expected=[
    'dashboard','markets','strategy','workspaces','brokers',
    'diagnostics','operations','private-live',
];
$paths=$registry->paths();
check(count($paths)===count($expected),'route_count');
foreach ($expected as $view) {
    check(($paths[$view]??null)==='/qsyn/terminal/'.$view,'canonical_'.$view);
    check($registry->isValidPath('/qsyn/terminal/'.$view),'registered_'.$view);
    check($registry->target('/qsyn/terminal/'.$view)===null,'no_redirect_loop_'.$view);
    check($registry->target('/qsyn/terminal/'.$view.'/')==='/qsyn/terminal/'.$view,
        'canonical_slash_'.$view);
}
check($registry->target('/qsyn/terminal')==='/qsyn/terminal/dashboard','root_alias');
check($registry->target('/qsyn/terminal/','strategy')==='/qsyn/terminal/strategy','old_query_bookmark');
check($registry->target('/qsyn/terminal','../../secret')==='/qsyn/terminal/dashboard','invalid_query');
foreach ([
    '/qsyn/studio'=>'strategy',
    '/qsyn/admin/rust'=>'operations',
    '/qsyn/legacy-chart'=>'diagnostics',
    '/qsyn/terminal/trading'=>'workspaces',
    '/qsyn/terminal/tools'=>'markets',
    '/qsyn/terminal/routes'=>'diagnostics',
] as $legacy=>$view){
    check($registry->isAlias($legacy),'legacy_detected_'.$view);
    check($registry->isAlias($legacy.'/'),'legacy_slash_'.$view);
    check($registry->target($legacy)==='/qsyn/terminal/'.$view,'legacy_route_'.$view);
    check($registry->target($legacy.'/')==='/qsyn/terminal/'.$view,'legacy_slash_target_'.$view);
}
foreach ([
    '/qsyn/','/qsyn/api/v1/admin/rust/action','/qsyn/terminalx',
    '/qsyn/terminal//diagnostics','/qsyn/terminal/no-such-page',
    '/qsyn/terminal/%2e%2e/operations','/qsyn/terminal/markets/extra'
] as $bad){
    check(!$registry->isValidPath($bad),'unknown_not_exposed');
    check($registry->target($bad)===null,'unknown_not_redirected');
}
check(!$registry->isTerminalRequest('/qsyn/api/v1/terminal/workspace'),'api_isolated');
echo "PASS: Single shared route manifest; canonical pretty URLs; safe aliases; unknown paths and APIs isolated\n";

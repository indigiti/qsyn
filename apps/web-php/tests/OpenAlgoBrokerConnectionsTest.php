<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/src/PrivateBrokerRegistry.php';
require_once dirname(__DIR__) . '/src/OpenAlgoBrokerConnectionsApi.php';
use QSYN\Broker\OpenAlgoBrokerConnectionsApi as Api;
function check(bool $ok, string $message): void {
    if (!$ok) throw new RuntimeException($message);
}
[$status, $catalog] = Api::dispatch('catalog', ['REQUEST_METHOD'=>'GET']);
check($status === 200 && count($catalog['brokers']) === 36, 'broker catalog incomplete');
check(in_array('upstox', $catalog['brokers'], true), 'Upstox missing');
check($catalog['trading_enabled'] === false && $catalog['connections_public'] === false,
    'public broker account exposure');
check(Api::dispatch('catalog', ['REQUEST_METHOD'=>'POST'])[0] === 405, 'catalog accepted POST');
foreach (['accounts', 'status', 'connect'] as $operation) {
    [$code, $data] = Api::dispatch($operation, ['REQUEST_METHOD'=>'GET']);
    check($code === 503 && $data['error'] === 'private_broker_connections_disabled',
        'private broker route did not fail closed');
}
echo "PASS OpenAlgo public names only; private broker access disabled by default\n";

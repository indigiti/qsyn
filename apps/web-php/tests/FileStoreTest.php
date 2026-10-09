<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/FileStore.php';

use QSYN\Storage\FileStore;

$root = sys_get_temp_dir() . '/qsyn-file-test-' . bin2hex(random_bytes(8));
$store = new FileStore($root);

function check(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}
function fails(callable $action): bool
{
    try {
        $action();
        return false;
    } catch (InvalidArgumentException | RuntimeException $e) {
        return true;
    }
}

check($store->get('workspaces', 'abc') === null, 'missing document should return null');
$a = $store->put('workspaces', 'abc', ['owner' => 'user-a', 'name' => 'Demo']);
check($a['revision'] === 1, 'new record revision');
$b = $store->put('workspaces', 'abc', ['owner' => 'user-a', 'name' => 'New'], 1);
check($b['revision'] === 2, 'increment revision');
check($store->get('workspaces', 'abc')['data']['name'] === 'New', 'persisted data');
check(fails(fn() => $store->put('workspaces', 'abc', ['name' => 'overwrite'], 1)), 'stale revision must fail');
check(fails(fn() => $store->put('workspaces', 'abc', ['name' => 'blind'])), 'blind overwrite must fail');
check(fails(fn() => $store->get('../escape', 'abc')), 'path traversal blocked');
check(fails(fn() => $store->get('workspaces', '../escape')), 'id traversal blocked');
check($store->get('workspaces', 'missing') === null, 'new record not found');
check(is_file($root . '/workspaces/abc.json'), 'record persisted to disk');
echo "PASS: file-backed storage checks (10 assertions)\n";

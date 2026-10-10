<?php
declare(strict_types=1);

namespace QSYN\Broker;

use QSYN\MarketData\OpenAlgoLocalProbe;

/**
 * Private operator-owned registry of independent OpenAlgo installations.
 *
 * The OpenAlgo application itself handles broker OAuth/TOTP, encrypted tokens,
 * exchange symbol mapping and its own broker plugins. QSYN stores neither
 * broker login secrets nor provider access tokens.
 */
final class PrivateBrokerRegistry
{
    private const BROKERS = [
        'fivepaisa', 'fivepaisaxts', 'aliceblue', 'angel', 'arrow',
        'compositedge', 'dhan', 'dhan_sandbox', 'definedge', 'deltaexchange',
        'firstock', 'flattrade', 'fyers', 'groww', 'hdfcsecurities',
        'hdfcsky', 'ibulls', 'iifl', 'iiflcapital', 'indmoney', 'jainamxts',
        'kotak', 'motilal', 'mstock', 'nubra', 'paytm', 'pocketful',
        'rmoney', 'samco', 'shoonya', 'tradejini', 'tradesmart',
        'upstox', 'wisdom', 'zebu', 'zerodha',
    ];

    public static function privateFile(string $path): string
    {
        if ($path === '' || !str_starts_with($path, '/') || is_link($path)) {
            throw new \RuntimeException('private_absolute_config_required');
        }
        $file = realpath($path);
        if ($file === false || $file !== $path || !is_file($file)
            || is_link($file) || !is_readable($file)) {
            throw new \RuntimeException('invalid_private_config_file');
        }
        if (preg_match('~/(?:public_html|public|webroot|www)/~i', $file)) {
            throw new \RuntimeException('private_config_inside_webroot');
        }
        $mode = fileperms($file);
        if ($mode === false || ($mode & 0077) !== 0) {
            throw new \RuntimeException('private_config_permissions');
        }
        if (function_exists('posix_geteuid') && fileowner($file) !== posix_geteuid()) {
            throw new \RuntimeException('private_config_owner');
        }
        if (filesize($file) === false || filesize($file) > 16384) {
            throw new \RuntimeException('private_config_size');
        }
        return $file;
    }

    /** @return array<string, array<string, mixed>> */
    public static function load(string $path): array
    {
        if (PHP_SAPI !== 'cli' || getenv('QSYN_PRIVATE_BROKER_GATEWAY') !== '1'
            || getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1') {
            throw new \RuntimeException('broker_gateway_disabled');
        }
        $input = file_get_contents(self::privateFile($path));
        if (!is_string($input)) {
            throw new \RuntimeException('private_config_unreadable');
        }
        $root = json_decode($input, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($root) || array_is_list($root)
            || ($root['schema'] ?? null) !== 'QSYN-PRIVATE-OPENALGO-REGISTRY/1'
            || !isset($root['accounts']) || !is_array($root['accounts'])
            || count($root['accounts']) === 0 || count($root['accounts']) > 16) {
            throw new \RuntimeException('unsupported_broker_registry');
        }
        $accounts = [];
        $ports = [];
        $keys = [];
        foreach ($root['accounts'] as $item) {
            if (!is_array($item) || array_is_list($item)
                || array_keys($item) !== [
                    'account_id', 'tenant_id', 'owner_user_id', 'broker',
                    'rest_port', 'ws_port', 'openalgo_apikey_file',
                ]) {
                throw new \RuntimeException('invalid_broker_account');
            }
            foreach (['account_id', 'tenant_id', 'owner_user_id'] as $key) {
                $value = $item[$key] ?? null;
                if (!is_string($value) || strlen($value) > 80
                    || preg_match('/^[a-zA-Z0-9._-]{1,80}$/D', $value) !== 1) {
                    throw new \RuntimeException('invalid_broker_account_identity');
                }
            }
            if (!in_array($item['broker'], self::BROKERS, true)) {
                throw new \RuntimeException('unsupported_openalgo_broker_plugin');
            }
            foreach (['rest_port', 'ws_port'] as $key) {
                $port = $item[$key];
                if (!is_int($port) || $port < 1025 || $port > 65535 || isset($ports[$port])) {
                    throw new \RuntimeException('duplicate_or_invalid_loopback_port');
                }
                $ports[$port] = true;
            }
            $path = $item['openalgo_apikey_file'];
            if (!is_string($path)) {
                throw new \RuntimeException('invalid_key_path');
            }
            // Check key file now; do not read the key until the selected call.
            self::privateFile($path);
            if (isset($keys[$path]) || isset($accounts[$item['account_id']])) {
                throw new \RuntimeException('duplicate_account_or_key_scope');
            }
            $keys[$path] = true;
            $accounts[$item['account_id']] = $item;
        }
        return $accounts;
    }

    public static function connection(array $accounts, string $tenant, string $owner, string $accountId): array
    {
        $account = $accounts[$accountId] ?? null;
        if ($account === null || $account['tenant_id'] !== $tenant
            || $account['owner_user_id'] !== $owner) {
            throw new \RuntimeException('account_scope_denied');
        }
        return $account;
    }

    public static function credential(array $account): string
    {
        return OpenAlgoLocalProbe::readPrivateKey($account['openalgo_apikey_file']);
    }

    public static function publicSummary(array $account): array
    {
        return [
            'account_id' => $account['account_id'],
            'tenant_id' => $account['tenant_id'],
            'owner_user_id' => $account['owner_user_id'],
            'broker' => $account['broker'],
            'source' => 'isolated_openalgo_instance',
            'broker_authorized' => false,
            'feed_entitlement_verified' => false,
            'trading_enabled' => false,
            'ui_mode' => 'unchanged',
        ];
    }
}

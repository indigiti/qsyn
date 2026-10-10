<?php
declare(strict_types=1);

namespace QSYN\Terminal;

use InvalidArgumentException;
use RuntimeException;
use QSYN\Storage\FileStore;

/**
 * Development-only file-backed, owner-scoped SIMULATED chart workspaces.
 * Not for licensed market data, real broker tokens or production identities.
 *
 * Each immutable storage key is derived solely from the authenticated session
 * tenant + principal. This class never accepts a client-selected owner.
 */
final class FileTerminalWorkspaceRepository
{
    private const COLLECTION = 'terminal_demo_workspaces';
    private const SCHEMA = 'QSYN-TERMINAL-BROWSER-WORKSPACES/1';
    private const SYMBOLS = [
        'QSYN-DEMO', 'QSYN-NIFTY-STRADDLE',
        'QSYN-BANKNIFTY-STRADDLE', 'QSYN-FINNIFTY-STRADDLE'
    ];
    private const MAX_DATA_BYTES = 130000;
    private const MAX_CHART_BYTES = 50000;

    public function __construct(private FileStore $store) {}

    private static function key(string $tenant, string $owner): string
    {
        return 'tw_' . substr(hash('sha256', $tenant . "\0" . $owner), 0, 40);
    }

    public static function defaults(): array
    {
        return ['schema' => self::SCHEMA, 'watchlist' => [
            'QSYN-DEMO', 'QSYN-NIFTY-STRADDLE'
        ], 'layouts' => []];
    }

    private static function assertKeys(array $value, array $keys): void
    {
        $actual = array_keys($value);
        sort($actual);
        sort($keys);
        if ($actual !== $keys) {
            throw new InvalidArgumentException('invalid_workspace_fields');
        }
    }

    private static function checkSymbol(mixed $symbol): void
    {
        if (!is_string($symbol) || !in_array($symbol, self::SYMBOLS, true)) {
            throw new InvalidArgumentException('unsupported_simulated_symbol');
        }
    }

    /**
     * Recursive denial prevents saving credentials or active order state in
     * an opaque widget-state object. This is a defense in depth, not approval
     * to persist arbitrary third-party or broker chart state.
     */
    private static function safeChartTree(mixed $value, int $depth = 0): void
    {
        if ($depth > 24) {
            throw new InvalidArgumentException('chart_state_too_deep');
        }
        if (is_array($value)) {
            if (count($value) > 1500) {
                throw new InvalidArgumentException('chart_state_too_large');
            }
            foreach ($value as $key => $nested) {
                if (is_string($key) && preg_match(
                    '/(?:token|secret|password|api.?key|credential|authorization|account.?id|order.?id)/i',
                    $key
                )) {
                    throw new InvalidArgumentException('chart_state_sensitive_field');
                }
                self::safeChartTree($nested, $depth + 1);
            }
        } elseif (!is_string($value) && !is_int($value) && !is_float($value)
            && !is_bool($value) && $value !== null) {
            throw new InvalidArgumentException('chart_state_invalid');
        } elseif (is_string($value) && strlen($value) > 12000) {
            throw new InvalidArgumentException('chart_state_too_large');
        }
    }

    public static function validate(mixed $input): array
    {
        if (!is_array($input)) {
            throw new InvalidArgumentException('invalid_workspace');
        }
        self::assertKeys($input, ['schema', 'watchlist', 'layouts']);
        if ($input['schema'] !== self::SCHEMA
            || !is_array($input['watchlist']) || !array_is_list($input['watchlist'])
            || count($input['watchlist']) > 4
            || !is_array($input['layouts']) || !array_is_list($input['layouts'])
            || count($input['layouts']) > 5) {
            throw new InvalidArgumentException('invalid_workspace');
        }
        $watchlist = [];
        foreach ($input['watchlist'] as $symbol) {
            self::checkSymbol($symbol);
            if (in_array($symbol, $watchlist, true)) {
                throw new InvalidArgumentException('duplicate_workspace_symbol');
            }
            $watchlist[] = $symbol;
        }
        $layouts = [];
        $usedNames = [];
        foreach ($input['layouts'] as $layout) {
            if (!is_array($layout)) {
                throw new InvalidArgumentException('invalid_layout');
            }
            self::assertKeys($layout, ['name', 'panes', 'chartStates']);
            $name = $layout['name'];
            if (!is_string($name) || preg_match('/^[a-zA-Z0-9 _-]{1,36}$/D', $name) !== 1
                || in_array(strtolower($name), $usedNames, true)
                || !is_array($layout['panes']) || !array_is_list($layout['panes'])
                || count($layout['panes']) < 1 || count($layout['panes']) > 2
                || !is_array($layout['chartStates']) || array_is_list($layout['chartStates']) && $layout['chartStates'] !== []) {
                throw new InvalidArgumentException('invalid_layout');
            }
            $usedNames[] = strtolower($name);
            $panes = [];
            $chartStates = [];
            foreach ($layout['panes'] as $index => $pane) {
                if (!is_array($pane)) throw new InvalidArgumentException('invalid_pane');
                self::assertKeys($pane, ['id', 'symbol']);
                $id = $index === 0 ? 'primary' : 'secondary';
                if ($pane['id'] !== $id) throw new InvalidArgumentException('invalid_pane');
                self::checkSymbol($pane['symbol']);
                $panes[] = ['id' => $id, 'symbol' => $pane['symbol']];
                if (!array_key_exists($id, $layout['chartStates'])) continue;
                $chart = $layout['chartStates'][$id];
                if (!is_array($chart) || array_is_list($chart)
                    || ($chart['symbol'] ?? null) !== $pane['symbol']
                    || ($chart['exchange'] ?? null) !== 'QSYN'
                    || ($chart['interval'] ?? null) !== '1m') {
                    throw new InvalidArgumentException('invalid_chart_state');
                }
                self::safeChartTree($chart);
                if (strlen(json_encode($chart, JSON_THROW_ON_ERROR)) > self::MAX_CHART_BYTES) {
                    throw new InvalidArgumentException('chart_state_too_large');
                }
                $chartStates[$id] = $chart;
            }
            foreach (array_keys($layout['chartStates']) as $key) {
                if (!array_key_exists($key, $chartStates)) {
                    throw new InvalidArgumentException('extraneous_chart_state');
                }
            }
            $layouts[] = ['name' => $name, 'panes' => $panes,
                'chartStates' => $chartStates];
        }
        $out = ['schema' => self::SCHEMA, 'watchlist' => $watchlist, 'layouts' => $layouts];
        if (strlen(json_encode($out, JSON_THROW_ON_ERROR)) > self::MAX_DATA_BYTES) {
            throw new InvalidArgumentException('workspace_too_large');
        }
        return $out;
    }

    public function getForOwner(string $tenant, string $owner): array
    {
        $record = $this->store->get(self::COLLECTION, self::key($tenant, $owner));
        if ($record === null) {
            return ['revision' => 0, 'workspace' => self::defaults()];
        }
        $data = $record['data'] ?? [];
        if (($data['tenant_id'] ?? null) !== $tenant || ($data['owner_user_id'] ?? null) !== $owner
            || !array_key_exists('workspace', $data)) {
            throw new RuntimeException('Corrupt tenant-scoped terminal workspace');
        }
        return [
            'revision' => (int) $record['revision'],
            'workspace' => self::validate($data['workspace']),
        ];
    }

    public function saveForOwner(string $tenant, string $owner, mixed $workspace, int $revision): array
    {
        if ($revision < 0 || $revision > 2147483647) {
            throw new InvalidArgumentException('invalid_revision');
        }
        $validated = self::validate($workspace);
        $record = $this->store->put(self::COLLECTION, self::key($tenant, $owner), [
            'tenant_id' => $tenant, 'owner_user_id' => $owner,
            'workspace' => $validated, 'updated_at' => gmdate('c'),
        ], $revision);
        return ['revision' => (int) $record['revision'], 'workspace' => $validated];
    }
}

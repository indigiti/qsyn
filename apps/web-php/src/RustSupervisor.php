<?php
declare(strict_types=1);

namespace QSYN\Admin;

use RuntimeException;

/**
 * Strictly allowlisted supervisorctl adapter. No shell, arbitrary process,
 * user-supplied program, PID, command, file path or arguments.
 *
 * The host operator must provision a dedicated qsyn-only supervisor instance
 * and explicitly opt in. Never grant PHP unrestricted root/service controls.
 */
final class RustSupervisor
{
    private const PROGRAM = 'qsyn-stream';
    private const VALID_ACTIONS = ['start', 'stop', 'restart'];

    public static function available(): bool
    {
        if (getenv('QSYN_CONTROL_ENABLED') !== '1'
            || !function_exists('proc_open')
            || !function_exists('proc_get_status')
            || !function_exists('proc_terminate')) {
            return false;
        }
        $binary = (string)(getenv('QSYN_SUPERVISORCTL_BIN') ?: '/usr/bin/supervisorctl');
        if (!in_array($binary, ['/usr/bin/supervisorctl', '/usr/local/bin/supervisorctl'], true)
            || !is_file($binary) || !is_executable($binary)) {
            return false;
        }
        $config = (string)(getenv('QSYN_SUPERVISORCTL_CONFIG') ?: '');
        return str_starts_with($config, '/')
            && is_file($config)
            && is_readable($config)
            && !is_link($config);
    }

    public static function execute(string $action): array
    {
        if (!in_array($action, self::VALID_ACTIONS, true)) {
            return ['ok' => false, 'error' => 'invalid_action'];
        }
        if (!self::available()) {
            return ['ok' => false, 'error' => 'service_manager_unavailable'];
        }
        $result = self::invoke($action);
        return $result['code'] === 0
            ? ['ok' => true, 'action' => $action, 'message' => 'service_command_accepted']
            : ['ok' => false, 'error' => $result['timeout'] ? 'service_manager_timeout' : 'service_manager_rejected'];
    }

    public static function status(): array
    {
        if (!self::available()) {
            return ['available' => false, 'state' => 'unavailable'];
        }
        $result = self::invoke('status');
        $first = strtoupper(trim($result['output']));
        $state = 'unknown';
        if (preg_match('/^qsyn-stream\s+(RUNNING|STOPPED|STARTING|STOPPING|FATAL|BACKOFF|EXITED)\b/', $first, $match)) {
            $state = strtolower($match[1]);
        }
        return ['available' => true, 'state' => $state];
    }

    /**
     * Use argv proc_open, never /bin/sh or a request parameter.
     * Output is read for status matching only and is never returned to users.
     * Terminates the child if supervisorctl hangs.
     */
    private static function invoke(string $action): array
    {
        $binary = (string)(getenv('QSYN_SUPERVISORCTL_BIN') ?: '/usr/bin/supervisorctl');
        $config = (string)getenv('QSYN_SUPERVISORCTL_CONFIG');
        $cmd = [$binary, '-c', $config, $action, self::PROGRAM];
        $pipes = [];
        $process = @proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            return ['code' => -1, 'timeout' => false, 'output' => ''];
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $output = '';
        $deadline = microtime(true) + 5.0;
        $exitCode = -1;
        $timeout = false;
        try {
            do {
                $output .= (string)stream_get_contents($pipes[1], 2048);
                // Do not leak arbitrary error text from the service manager.
                stream_get_contents($pipes[2], 2048);
                $state = proc_get_status($process);
                if (!$state['running']) {
                    $exitCode = (int)$state['exitcode'];
                    break;
                }
                if (microtime(true) >= $deadline) {
                    $timeout = true;
                    proc_terminate($process);
                    break;
                }
                usleep(25000);
            } while (true);
        } finally {
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
        }
        return ['code' => $exitCode, 'timeout' => $timeout, 'output' => substr($output, 0, 4096)];
    }
}

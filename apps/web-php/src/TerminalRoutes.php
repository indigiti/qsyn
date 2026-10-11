<?php
declare(strict_types=1);

namespace QSYN\Routing;

/**
 * One deployable, read-only registry of React terminal pages and retired aliases.
 * It is NOT an authentication system: Rust admin, private chart, broker and
 * workspace APIs continue validating their own account/session/CSRF rights.
 */
final class TerminalRoutes
{
    private array $views = [];
    private array $aliases = [];
    private string $base = '/qsyn/terminal';
    private string $default = 'trading';

    public function __construct(string $manifest)
    {
        $raw = is_file($manifest) ? file_get_contents($manifest) : false;
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data) || ($data['schema'] ?? null) !== 'QSYN-TERMINAL-ROUTES/1'
            || ($data['base'] ?? null) !== $this->base
            || !is_array($data['routes'] ?? null)
            || !is_array($data['aliases'] ?? null)
            || !is_string($data['defaultView'] ?? null)) {
            throw new \RuntimeException('terminal_routes_unavailable');
        }
        foreach ($data['routes'] as $route) {
            if (!is_array($route) || !is_string($route['view'] ?? null)
                || !is_string($route['slug'] ?? null)
                || !preg_match('/\A[a-z][a-z0-9-]{0,39}\z/D', $route['view'])
                || $route['view'] !== $route['slug']
                || isset($this->views[$route['view']])) {
                throw new \RuntimeException('invalid_terminal_route');
            }
            $this->views[$route['view']] = $this->base . '/' . $route['slug'];
        }
        if (!isset($this->views[$data['defaultView']])) {
            throw new \RuntimeException('invalid_default_terminal_route');
        }
        $this->default = $data['defaultView'];
        foreach ($data['aliases'] as $alias) {
            if (!is_array($alias) || !is_string($alias['path'] ?? null)
                || !is_string($alias['view'] ?? null)
                || !preg_match('#\A/qsyn/[a-z][a-z0-9/-]{0,70}\z#D', $alias['path'])
                || !isset($this->views[$alias['view']])
                || isset($this->aliases[$alias['path']])) {
                throw new \RuntimeException('invalid_terminal_alias');
            }
            $this->aliases[$alias['path']] = $this->views[$alias['view']];
        }
    }

    public function isTerminalRequest(string $path): bool
    {
        return $path === $this->base || $path === $this->base . '/'
            || str_starts_with($path, $this->base . '/');
    }

    public function target(string $path, ?string $legacyView = null): ?string
    {
        $normalized = ($path !== '/qsyn/' && str_ends_with($path, '/'))
            ? rtrim($path, '/') : $path;
        if (isset($this->aliases[$normalized])) {
            return $this->aliases[$normalized];
        }
        if ($normalized === $this->base) {
            if ($legacyView !== null && isset($this->views[$legacyView])) {
                return $this->views[$legacyView];
            }
            return $this->views[$this->default];
        }
        foreach ($this->views as $canonical) {
            if ($normalized === $canonical) {
                return $path !== $canonical || $legacyView !== null
                    ? $canonical : null;
            }
        }
        return null;
    }

    public function isValidPath(string $path): bool
    {
        return in_array($path, $this->views, true);
    }

    public function isAlias(string $path): bool
    {
        return isset($this->aliases[rtrim($path, '/')]);
    }

    public function paths(): array
    {
        return $this->views;
    }
}

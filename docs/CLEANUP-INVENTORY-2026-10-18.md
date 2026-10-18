# QSYN UI and release cleanup inventory — 18 October 2026

The maintained chart entry point is `frontend/src/terminal.jsx` (homepage and protected React terminal). The second retained entry point, `frontend/src/account-chart.js`, supports gated development-only mock-account tests. The strategy UI is `frontend/src/terminal-strategy.jsx`; the discontinued standalone `studio.js` application and `studio-lab.js` are **not** part of the live product.

## Removed in the first cleanup

- Old standalone demo chart `main.js`, independent Studio JS/Lab entry and obsolete Studio CSS.
- Five legacy Rust/chart administration browser scripts used by retired standalone dashboards; both original PHP entrypoints remain safe redirect shims.
- Four-entrypoint build reduced to the two maintained entrypoints; release excludes obsolete JS files, with assertions preventing accidental return.
- Unreachable legacy Dashboard/StatusBox React implementations (the actual overview is `DashboardCockpit`).

## Deliberately retained

- `rust-demo-feed.js` is imported by the active simulated workspace feed.
- `/qsyn/studio`, `/qsyn/admin/rust` and `/qsyn/legacy-chart` compatibility redirects, and canonical terminal paths.
- Workspaces and mock-account test contracts, provider/owner authorization, native Upstox and Rust feeds, historical gap reconciliation, chart rendering and Wick Science.
- Historical `docs/` plans: not necessarily accurate operational runbooks. Do not rely on phase-era instructions over current code and deployment evidence.

## Rules for future changes

1. Add a new browser build entry only when it has an actively served route and a browser regression test.
2. Do not package JavaScript/CSS for retired redirect-only documents.
3. Keep legacy deep links as safe redirects rather than resurrecting separate frontends.
4. Only remove source/provider integrations after verifying actual imports, API callers, CI checks and private deployment dependencies.
5. Never interpret a smaller deployment artifact as evidence that Rust or broker features can safely be deleted.

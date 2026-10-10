# QSYN Phase 2 — functional chart workspace (simulation-only)

This change expands the existing `/qsyn/terminal` with a bounded instrument picker, two-chart comparison, a browser-local watchlist, and named workspaces. It does not install Python, SQLite, DuckDB or a database service.

## Valid instrument scope

Only `QSYN-DEMO`, `QSYN-NIFTY-STRADDLE`, `QSYN-BANKNIFTY-STRADDLE`, and `QSYN-FINNIFTY-STRADDLE` are selectable. This is **not exchange search**. OpenAlgo Charts' built-in search input cannot cause the bridge to query arbitrary broker symbols: unsupported IDs return no bars. Both widget charts use a whitelisted `QSYN` exchange and **1m** candles only.

The synthetic adapter uses the existing same-origin read-only `/qsyn/api/v1/studio/market` and `/qsyn/api/v1/studio/bars` endpoints. For each request it obtains the current deterministic ATM strike, creates one BUY CE and one BUY PE at that strike (W1 expiry), and charts the combined premium magnitude calculated from synchronized 15-second samples by the existing PHP simulation. This ATM strike can change between reloads and must not be treated as a historical fixed contract. Units are fictional premium points, not INR, and are unrelated to licensed market data.

## Storage and ownership boundaries

- Users may add/remove rows from a *local browser watchlist*, save up to five named chart layouts, select/open/delete layouts, and compare two charts.
- Each saved layout retains up to two selected simulated instruments plus safe widget chart state, including drawing/indicator state where supported by OpenAlgo Charts. The local format is schema-validated and bounded to avoid accidental storage abuse.
- Storage is limited to browser `localStorage` in the current origin; it is **not server-side file persistence, authenticated account sync, account isolation, cross-device backups or an OMS**. Labels explicitly communicate this.
- No `/auth`, Flask, Upstox authorization, order endpoint or private Rust feed is called. Unsupported data inputs are rejected or return empty arrays.
- Current PHP file-backed mock user workspaces, private WAL/history and Rust OMS remain unchanged.
- Live broker markets and orderbook/positions controls remain disabled until separately accepted.
- Existing public `/qsyn/` homepage remains unchanged; this is an additive staging terminal.

## Acceptance

- CI Node regression verifies the catalog, denied arbitrary tickers, layouts, malformed browser storage, duplicate instruments, and overflow limits.
- Playwright/Chromium browser acceptance verifies two widget canvases, a real simulated ATM two-leg request, browser watchlist persistence, saved layout reload, same-origin CSP and no broker order/auth calls.
- Existing PHP/Rust/chart tests and DigiOps packaging must pass.
- After matching DigiOps artifact is deployed, inspect `https://stage.digiti.in/qsyn/terminal` on desktop and mobile and verify simulated data labeling. Do not promote the public homepage until those screenshots and UI parity are approved.

**Still pending:** exact upstream OpenAlgo UI parity; production licensed instrument search and authenticated WSS; per-account server-file watchlists and layout persistence; full integrated options strategy builder, durable paper OMS and controlled live trading.

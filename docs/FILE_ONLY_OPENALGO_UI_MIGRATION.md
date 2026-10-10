# QSYN file-only OpenAlgo UI adoption — first browser-ready slice

**2026-10-10 · Architecture change:** QSYN's public web remains PHP and the market pipeline remains Rust. This milestone introduces a React chart terminal without starting OpenAlgo's Flask backend or adopting its SQLite/DuckDB stores. No MariaDB, PostgreSQL, Redis, RabbitMQ or Python service is required for this UI slice.

## Honest implementation boundary

OpenAlgo upstream is **not a standalone frontend component library**. Its native `Layout` and `Navbar` depend on Flask authentication, Zustand broker sessions, order API endpoints and Socket.IO. Simply copying all upstream assets to `/qsyn/` would produce broken screens and unsafe trading affordances.

We therefore begin with a **QSYN-owned React shell adapted from the OpenAlgo navigation structure and visual design**, plus the **actual** `openalgo-charts@2.6.0` widget, rather than claiming all upstream pages have been transplanted.

Upstream references at `marketcalls/openalgo@12e1114657981a3e50dde8c8ce04eb778ae1cf2f`:
- `frontend/src/config/navigation.ts`: structure and vocabulary of workspace and broker navigation.
- `frontend/src/components/layout/Navbar.tsx` and `MobileBottomNav.tsx`: responsive nav, menus and light/dark preferences.
- `frontend/src/index.css`: common surface and theme semantics.

The new shell and CSS explicitly credit these AGPL-3.0 upstream sources; the native upstream charts remain separately Apache-2.0. Review corresponding-source obligations before production exposure of adapted components. Existing upstream repository/branding is not rewritten.

## Added

- `/qsyn/terminal` is a **noindex, read-only, simulated** browser route. It does not replace `/qsyn/` during phased acceptance.
- React top navigation, desktop left navigation, mobile drawer and bottom nav, light/dark toggle, functional Dashboard / Trading / Tools tabs and deep links.
- Actual upstream OpenAlgo Charts widget, indicators, drawings and chart toolbar on simulated PHP `/qsyn/api/v1/demo/bars`. Rust diagnostic WS polling remains disabled by default.
- Links to existing `/qsyn/studio` for synthetic CE/PE lab. `Orderbook`, `Positions`, and `Broker accounts` appear **disabled** because authentication and durable live OMS have not been accepted.
- Capabilities are read only from `/qsyn/api/v1/studio/capabilities` and fail closed to simulation/offline.
- No user credentials, order placement, broker access, Rust supervisor access or underlying persistence migration.
- Built with esbuild in CI. Node is build-time only; the deployed PHP app serves static terminal HTML/JS/CSS.
- Browser tests assert candle canvas, responsive navigation, theme, disabled broker controls, deep link, CSP and no calls to authentication/order APIs.

## Acceptance / rollout

1. Merge only after lint, PHP, Rust, Chromium and DigiOps packaging checks pass.
2. Deploy the matching `digiops-release` artifact in staging.
3. Inspect `https://stage.digiti.in/qsyn/terminal` on desktop/mobile and compare against OpenAlgo's original navigation. Inaccurate UX gaps should be addressed as a separate, documented parity backlog.
4. Keep `/qsyn/` prototype and /admin/rust working for rollback until accepted.
5. Migrate further OpenAlgo tools **one screen at a time**, using QSYN REST/feed contracts and replacing enabled endpoints; do not silently retain /auth or /api/v1/placeorder calls from the upstream frontend.
6. After original UI layout/menu/theme/chart parity and accessible navigation tests pass, change only the public homepage route to point to this product UI, retaining isolated admin diagnostics.
7. Independently validate production account scope, real CE/PE licensed data, chart WS and file-WAL recovery before enabling live chart subscriptions, paper OMS and eventually live execution.

## Storage non-negotiables

- QSYN's current dev/test user metadata remains private file-backed records.
- Real market history is the Rust scoped WAL + immutable binary candle files under private approved storage.
- No OpenAlgo SQLite or DuckDB databases are imported into this frontend-only route.
- Native OpenAlgo Flask remains a *separate optional integration path*, not a prerequisite for this UI release.
- File-backed account/credential stores are **not automatically production-ready** for unrelated real-money users; encryption, tenancy, credential rotation, transaction guarantees and audit/backup remain separate gates.

## Staging commands

```sh
cd frontend
npm install
npm run build

# For a local PHP smoke test, copy terminal.js and terminal.css into
# apps/web-php/public/assets/ (DigiOps CI packages them automatically).
php -S 127.0.0.1:8000 -t apps/web-php/public apps/web-php/dev-router.php
# GET http://127.0.0.1:8000/qsyn/terminal
```

**This is the first UI migration slice, not full OpenAlgo UI parity, real public market charting, or authenticated trading.**

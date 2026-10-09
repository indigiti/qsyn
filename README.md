# QSYN

Multi-user synthetic-market charting platform. **Phase 0 foundation only** — not a live Upstox-connected trading application.

Canonical requirements: [Master Blueprint v1.4](docs/MASTER_BLUEPRINT.md).

## Implemented on this branch

- PHP 8.3-compatible development terminal and simulated 1-minute candle endpoint.
- Reusable, database-free PHP file storage class with revision-checked atomic document updates and basic tests.
- OpenAlgo Charts 2.6.0 widget integration, bundled as a static browser asset.
- Rust/Tokio service skeleton: health endpoint, opt-in local-only simulated WebSocket, CE+PE synthetic candle builder and unit tests.
- GitHub Actions tests and a staged DigiOps artifact named **digiops-release**, with segregated public/private folders.

**Not implemented:** real Upstox OAuth, OpenAlgo adapter/session isolation, authenticated multi-user API, durable WAL/segment history, production credentials, live trading, or Cloudways daemon setup. Do not use the prototype for trading or real accounts.

## Run locally — no MariaDB, Redis, RabbitMQ or Node server

Requirements: PHP 8.3+, Rust stable, Node 22+ **for asset build only**.

~~~bash
php apps/web-php/tests/FileStoreTest.php
cargo test --manifest-path services/stream-rust/Cargo.toml
cd frontend && npm install && npm run build
cd ..
mkdir -p apps/web-php/public/assets
cp frontend/dist/chart.js apps/web-php/public/assets/chart.js
php -S 127.0.0.1:8000 -t apps/web-php/public apps/web-php/dev-router.php
~~~

Open http://127.0.0.1:8000/qsyn/ to view the **simulated** chart.
A PHP health endpoint is available at /qsyn/api/v1/health; /qsyn/api/v1/demo/bars returns demonstration OHLC data.

To start the separate **localhost-only** Rust service:

~~~bash
cargo run --manifest-path services/stream-rust/Cargo.toml
curl http://127.0.0.1:10251/health
~~~

The demo WebSocket at /ws/demo is disabled by default. For local testing only, start with QSYN_ENABLE_DEMO_WS=1. This simulated WebSocket is not connected to the chart widget or a real broker.

## Development file store

FileStore takes a **private absolute directory** and exposes get()/put() with optimistic revisions. It is for disposable workspaces, mock broker accounts and fixtures, not production authentication, real secrets or live orders. Its locking and atomic record publication are a starting implementation; durable journal/recovery, tenant authorization, encryption and the later optional MariaDB adapter remain planned. Never place file-backed state under public_html or commit live credentials.

## Deploy and update flow

See [DigiOps integration](infrastructure/DIGIOPS.md). The release workflow publishes a GitHub Actions artifact, **not** a live Cloudways deployment. The actual Cloudways app, PHP routing, Rust/OpenAlgo long-running processes, WSS proxy/TLS, upgrades, backup and rollbacks require environment-specific validation.

OpenAlgo and OpenAlgo Charts must remain pinned and independently upgradeable; the production feed adapter will keep provider secrets on the server, not in the browser.

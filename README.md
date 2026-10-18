# QSYN

Multi-user synthetic-market charting platform with a database-free PHP/React terminal, simulated and public crypto feeds, and private broker-readiness components. The repository does not itself attest a deployed, licensed live Upstox trading service.

Canonical requirements: [Master Blueprint v1.4](docs/MASTER_BLUEPRINT.md).

## Implemented on this branch

- PHP 8.3-compatible development terminal and simulated 1-minute candle endpoint.
- Reusable, database-free PHP file storage class with revision-checked atomic document updates and basic tests.
- OpenAlgo Charts 2.6.7 integrated in the unified React terminal and chart-only homepage.
- Rust/Tokio service skeleton: health endpoint, opt-in local-only simulated WebSocket, CE+PE synthetic candle builder and unit tests.
- GitHub Actions tests and a staged DigiOps artifact named **digiops-release**, with segregated public/private folders.

**Production gates remain unverified:** live exchange display/retention entitlements, current BOD attestation, continuously supervised Upstox streams, account-isolated operational acceptance, Cloudways deployment parity, and authorized trading. Source modules for native Upstox OAuth, private Rust workers, durable WAL and restricted charts exist, but passing CI or resolving instrument keys does not activate those services. Trading remains disabled by default.

## Run locally — no MariaDB, Redis, RabbitMQ or Node server

Requirements: PHP 8.3+, Rust stable, Node 22+ **for asset build only**.

~~~bash
php apps/web-php/tests/FileStoreTest.php
cargo test --manifest-path services/stream-rust/Cargo.toml
cd frontend && npm install && npm run build
cd ..
mkdir -p apps/web-php/public/assets
cp frontend/dist/terminal.js apps/web-php/public/assets/terminal.js
cp frontend/dist/terminal.css apps/web-php/public/assets/terminal.css
php -S 127.0.0.1:8000 -t apps/web-php/public apps/web-php/dev-router.php
~~~

Open http://127.0.0.1:8000/qsyn/ for the chart-only homepage (public crypto; NSE/BSE index history remains owner-authorized). Protected workspace pages live under `/qsyn/terminal/`.
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

## Rust administration (opt-in)

The Rust operations page is available at `/qsyn/terminal/operations` (`/qsyn/admin/rust` redirects there) with **Start / Stop / Restart / Refresh / Health**. This feature is **disabled by default**. It requires either opt-in direct Rust lifecycle mode (no Supervisor) or a Cloudways-approved restricted Supervisor configuration, a server-injected administrator password hash, and PHP process-control permission. It never executes arbitrary browser-supplied commands. See [DigiOps service control guidance](infrastructure/DIGIOPS.md) for setup and security gates.

No permission has yet been granted to start the Rust daemon on Cloudways; the page will show service controls unavailable until Cloudways supplies a supported manager. The health button remains usable even when actions are disabled.

## Reliability and staging acceptance

The optional development private-file workspace is checked only when the operator chooses **Refresh private file status**; it is not needed for browser-only chart layouts. The endpoint is deliberately disabled by default, and an upstream 503 is never treated as authorization.

CI checks PHP/Rust/frontend behavior and packages DigiOps artifacts; those results do not establish live Cloudways deployment parity. The read-only public staging acceptance workflow requires an explicitly operator-confirmed **deployed full SHA** via manual `workflow_dispatch`; it no longer assumes that an old known SHA is still deployed. Do not enable feed, identity, execution or exchange data permissions solely to make a probe green.

# QSYN — Master Architecture Blueprint v1.5

**Status:** Architecture baseline for implementation; deployment and licensing gates remain open  
**Updated:** 2026-10-09  
**Repository:** https://github.com/indigiti/qsyn  
**Supersedes:** Blueprint v1.4; retains multi-broker account design and adds an opt-in authenticated Rust runtime management boundary

> This document is the canonical QSYN architecture. A completed item must be backed by code, tests, and deployment evidence. Statements marked "proposed", "target", or "pending" are not deployed capabilities.

## 1. Purpose and non-negotiable design rules

QSYN is a multi-user, multi-broker-account Indian-market charting and synthetic-instrument platform, initially using Upstox, OpenAlgo, and OpenAlgo Charts. The core use cases are realtime NIFTY/options charts, ATM straddles/strangles, multi-leg premium baskets, configurable synthetic indices, saved workspaces, and eventually trading.

1. Reuse maintained OpenAlgo/OpenAlgo Charts interfaces and features before implementing alternatives.
2. Keep QSYN's custom code, data contracts, accounts, and storage independent from upstream internals.
3. Treat QSYN and QNXT as entirely separate projects; QNXT is not a dependency.
4. Process realtime ticks in Rust memory without forcing them through PHP, MariaDB, Redis, or RabbitMQ.
5. Use **file-based storage for QSYN market-data history** and **file-backed application persistence for development/testing**, without MariaDB; do **not** remove OpenAlgo's own native databases. Preserve a clean, opt-in MariaDB migration path for user-facing application records.
6. No production Node.js server. Build-time JavaScript/TypeScript tooling may run in CI.
7. Do not share one user's broker data with others without verified provider/exchange permissions.
8. Keep order execution and credential management isolated from public chart broadcasting.
9. All upstream upgrades must be pinned, tested, staged, approved, and rollback-ready.
10. Never make MariaDB, Redis, or RabbitMQ a prerequisite for local development, test fixtures, or the default CI suite; do not enable live trading or production user credentials in the file-backed development profile.

## 2. Frozen stack and ownership

| Area | Baseline | Owner / boundary |
| --- | --- | --- |
| Initial broker | Upstox market-data APIs | Broker contract and entitlements |
| Broker abstraction, orders, upstream history/options | OpenAlgo (Python) | Upstream-managed integration; avoid core forks |
| Realtime ingestion, normalization, synthetics, candles, fan-out | Rust + Tokio | QSYN-owned service |
| Chart rendering, indicators, drawings, layouts, replay UI | OpenAlgo Charts (JS/TS) | Upstream library + QSYN feed adapter |
| Main website and auth API | PHP 8.2+ application | QSYN-owned |
| User/account/broker metadata and transactional records | Private file-backed store in dev/test; optional MariaDB adapter later | QSYN-owned versioned store interface |
| Volatile caches/rate limits where justified | In-process Rust cache; Redis optional | Not in the market-data critical path |
| Background admin jobs | PHP workers / Supervisord where supported | RabbitMQ optional |
| Market tick/candle history | Append-only WAL + immutable indexed binary segments | QSYN Rust storage |
| OpenAlgo own persistence | Existing SQLite / DuckDB as supplied upstream | Do not replace or manipulate directly |
| Preferred hosting | Cloudways Flexible, subject to persistent-process validation | Alternative execution host allowed for Rust/OpenAlgo |
| CI and dependency maintenance | GitHub Actions + dependency-update tooling | QSYN-owned |

**Rationale for progressive storage:** QSYN local development and automated testing should run without MariaDB, Redis or RabbitMQ. File-based adapters may persist synthetic test identities, mock broker connections, workspace settings and other non-production application state. The production application store remains a separate security/correctness decision; use the optional MariaDB adapter when transactional multi-user requirements justify it, rather than silently relying on development files for real funds or credentials. OpenAlgo currently uses its own SQLite operational stores and DuckDB Historify; leave them untouched for upstream compatibility. Rust, not Go, implements the QSYN market-data file engine.

## 3. Logical architecture and data flow

~~~text
Upstox V3 (initially; others later)
              |
       OpenAlgo broker adapters
       |                  |
 authenticated REST   normalized realtime WS / ZMQ proxy
       |                  |
 PHP orchestration     QSYN Rust service
 (tenants/keys)        - source adapters and subscription registry
       |               - entitlement-aware routing
       |               - tick normalization and source health
       |               - synthetic formulas / rolling ATM resolution
       |               - candle builders and hot memory cache
       |               - file WAL writer + indexed history reader
       |               - outbound WSS gateway / REST bars API
       |                  |
       +---- signed, short-lived viewer permissions ----+
                          |
             OpenAlgo Charts feed adapter
                          |
                 QSYN PHP web application
                 dashboards / chart workspaces
~~~

- **Hot path:** upstream feed -> Rust normalization -> approved instrument or synthetic updates -> authorized WebSocket viewers.
- **Persistence path:** Rust event pipeline -> bounded dedicated writer -> WAL -> snapshots / immutable history blocks / indexes.
- **History path:** chart getBars -> authenticated QSYN history API -> hot cache or indexed file read.
- **Control plane:** PHP auth, credentials, billing/roles, layouts, strategy definitions and administration; communicates with Rust through restricted APIs.
- **Trading path:** authenticated, permissioned requests -> OpenAlgo broker order APIs with independent risk controls; never use chart WebSocket for privileged order execution.

## 4. OpenAlgo / OpenAlgo Charts reuse policy

Use OpenAlgo's documented broker adapters, symbol/expiry lookup, quotes, history, option APIs, portfolio/order APIs, WebSocket proxy, and applicable sandbox tools. Avoid modifying its databases or exposing its API keys to browsers. OpenAlgo installations are broker-session-oriented: QSYN must explicitly isolate user sessions (initially isolated instances/process contexts if necessary); it must not assume one stock OpenAlgo instance supports many independent authenticated broker accounts safely.

Use OpenAlgo Charts' published widget, workspace/grid, indicators, drawings, transforms and data-feed APIs. Implement the QSYN adapter at the supported data-feed boundary, including historical bars and realtime updates. Prefer upgrading the library rather than copying its source.

Pin both upstream projects to **tested versions**. Versions observed at planning time are not automatic upgrade targets; a release is eligible only when QSYN's compatibility suite passes.

### Multiple broker accounts per QSYN user — mandatory feature

**Product requirement:** A single QSYN login can link **many distinct Upstox accounts** and **accounts from other supported brokers simultaneously** (e.g., Upstox A, Upstox B, Zerodha, Dhan). Multiple separate QSYN users can each attach their own list. Support linking, labelling, switching, disconnecting, re-authorizing and monitoring every account individually; there is no requirement to use one broker or one broker account per QSYN user.

**Initial compatibility architecture:** An upstream OpenAlgo instance is single-broker/single-session oriented. For concurrent broker accounts, run isolated OpenAlgo process contexts with separate configurations, local ports, native databases, access tokens, callback routing and supervision. QSYN's PHP control plane maps each linked account to its designated OpenAlgo context and the Rust ingestion source. No secrets or accounts are shared between instances. A more efficient multi-tenant ingestion adapter may later be introduced for eligible providers, but must preserve the same identity, source and entitlement contracts.

**Linked account registry contract (logical fields; implementation pending):** `account_id` (QSYN UUID), `owner_user_id`, `tenant_id`, `broker_code`, `broker_account_reference` (protected), `display_label`, `integration_instance_id`, `auth_status`, `authorized_scopes`, `token_expires_at`, `feed_entitlements`, `last_healthcheck_at`, `is_default_chart_source`, `execution_allowed`, `created_at`, `updated_at`, `revision`. Multiple entries with the same broker_code are allowed, but each linked external account must be distinct and ownership-checked. The credential vault stores encrypted secrets separately, referenced by opaque IDs.

**Broker authorization:** For Upstox, use its official OAuth authorization-code flow and redirect callbacks; never collect Upstox login passwords. Authorization, token expiry, re-login, instrument coverage, static-IP registration and WebSocket subscription limits remain **per linked broker account and provider policy**. The Upstox Market Data Feed V3 documents account-level connection and subscription limits; no design assumes unlimited sockets or multiple identities sharing a provider entitlement.

**Charts and order safety:**
- Chart selection can reference a specific authorized account's data or a separately licensed platform feed, with explicit provenance. Synthetic legs must be within the same permitted scope or an expressly licensed allowed combination.
- Preserve `account_id`, source_id and entitlement_scope throughout ingestion, cache keys, synthetic series IDs, historical storage and browser authorization. Identical instrument names from separate accounts must not silently collapse into a globally redistributable price series.
- The user selects a **specific execution account** before any broker order is prepared; visually show the broker/account label on confirmations. No implicit order routing to a default account after account-switch events.
- One disconnected/expired account must not take down other connected accounts or erase other users' subscriptions. Account un-linking revokes tokens, workers and permissioned subscriptions, with auditable cleanup.
- Aggregate portfolio views are optional later and must preserve a drill-down by linked broker account; trades are executed independently per account with explicit confirmation.

**Regulatory and deployment gate:** OpenAlgo's multi-instance guidance discusses using multiple accounts belonging to oneself/family and potential registered static-IP restrictions. Do **not** infer this authorizes one hosted system to run arbitrary unrelated customers' accounts or to redistribute their market data. Verify broker, exchange and Indian regulatory requirements before enabling paid multi-tenant BYOK hosting, shared IP setups or customer order execution.

**Development/testing without MariaDB:** Implement the linked-account repository through the existing file-backed PHP storage interface with **mock Upstox A, mock Upstox B and another mock broker**; credentials are fake, live trading is disabled. All linked-account interfaces must pass contract tests against file storage and, when implemented, the optional MariaDB adapter. Account metadata migrates through the standard file-to-MariaDB export/import/check process; OpenAlgo's own native database remains outside this migration.

**Performance/scaling rule:** Start with isolated OpenAlgo contexts for validation, but measure actual RAM, process count, login churn and feed connection limits. Do not assert that one OpenAlgo process per customer scales to thousands of accounts on a Cloudways host without benchmark and hosting approval. The Rust engine should multiplex **authorized** subscriptions across its output gateways without changing feed ownership.


## 5. Storage architecture v1.4 (database-free dev/test + memory-first market data)

| Data class | Canonical storage | Reliability rule |
| --- | --- | --- |
| Latest ticks, current candle, source health | Rust bounded in-memory structures | Ephemeral; rebuild on reconnect/recovery |
| Optional retained raw feed events | Checksummed append-only WAL / binary blocks | Subject to licensing and retention policy |
| Completed ordinary candles | Date/instrument/timeframe partitioned immutable binary blocks | Indexed range reads; verified publishing |
| Completed synthetic candles | Versioned synthetic-series binary blocks | Preserve leg mapping, formula, roll rules |
| Active synthetic definitions | Application storage interface: private JSON/journal in dev/test; optional MariaDB later | Versioned definitions, atomic/transactional update semantics |
| Workspace/drawing documents | Application storage interface: private JSON/journal in dev/test; optional MariaDB later | Tenant-scoped, atomic publishing and revision checks |
| Users, roles, entitlements, sessions, key metadata | File-backed **mock/test data only** in dev/test; MariaDB adapter available later | Auth checks, revisioning, revocation; production requires independent security sign-off |
| OpenAlgo platform state / Historify | Its own native stores | Managed only by supported OpenAlgo interfaces |
| Analytical extracts (optional) | Partitioned Parquet | Batch-derived, rebuildable |

**Disk layout (illustrative):**

~~~text
storage/
  market/
    wal/<writer-partition>/active.wal
    ticks/<source>/<instrument>/<session-date>/{part-0001.bin.zst,part-0001.idx}
    candles/<instrument>/<timeframe>/<yyyy-mm>/{part-0001.bin.zst,part-0001.idx}
    manifests/<series>.json
  synthetics/
    definitions/<strategy-id>/<version>.json
    candles/<series-id>/<timeframe>/<yyyy-mm>/{part-0001.bin.zst,part-0001.idx}
    checkpoints/
  snapshots/<engine-partition>/
  analytics/
  backups/
~~~

Partition by stable instrument ID, trading session and expected file size; do not generate millions of tiny files. Indexed compressed files must use independent compressed blocks or frame offsets that can actually be sought and decompressed efficiently.

### Database-free development and testing profile

**Default for development and CI:** `QSYN_APP_STORE=file`. Multiple linked accounts per user are modelled as file-backed mock entries in this mode. Do **not** install, boot, or connect to MariaDB for ordinary QSYN local development, test suites, demos, or fixture-backed acceptance testing. Redis and RabbitMQ remain optional. This only applies to **QSYN-owned application storage**; when integration testing a real OpenAlgo instance, its upstream SQLite/DuckDB dependencies remain.

Example environment settings (proposed contracts, not currently implemented):

~~~dotenv
QSYN_ENV=development
QSYN_APP_STORE=file
QSYN_APP_STORAGE_DIR=/absolute/private/path/qsyn-app-store
QSYN_ALLOW_REAL_BROKER_CREDENTIALS=false
QSYN_ENABLE_LIVE_TRADING=false
~~~

- File-backed adapter supports user fixtures, mock broker accounts, roles and entitlements, workspaces/drawings, synthetic definitions, settings, and simulated audit records. Passwords, even in test data, must use a maintained password-hashing algorithm. Prefer seeded disposable identities and **mock tokens**; never commit genuine Upstox API keys or refresh tokens to Git.
- Keep all application files **outside the public web root**. Exclude them from version control, use restrictive filesystem permissions, and isolate test suites in ephemeral storage directories.
- Define PHP-facing repository interfaces such as `UserRepository`, `BrokerConnectionRepository`, `WorkspaceRepository`, `SyntheticDefinitionRepository` and `AuditRepository`. Application features depend on these interfaces, not SQL syntax, filesystem paths or implementation-specific query methods.
- Store records with stable UUIDs, `schema_version`, tenant ID, revision, timestamps and a canonical serialization format. Normalize money, time and enum representations at the domain boundary so JSON and MariaDB backends have identical behavior.
- For local concurrent writes, use a **single application writer or explicit advisory locking**, atomic temp-file + fsync + rename where supported, plus a bounded checksummed operation journal. Never permit two PHP requests to overwrite the same user/account revision silently. Index/rebuild tooling and crash-recovery tests are required.
- Avoid unbounded per-tick files or millions of user JSON objects. Market tick/candle history belongs to the separate Rust file engine; the PHP file adapter stores low-frequency application state only.
- API authentication, tenant isolation, revocation, validation and tests must run identically under both implementations. File-backed development is **not** automatically approved for real customer accounts, live order execution, or payments.

### Future switch to MariaDB — no code rewrite

**The switching boundary is the application storage adapter, not the chart or Rust market-data engine.** MariaDB is a supported *future option*, not a prerequisite or automatic production default. Introduce `QSYN_APP_STORE=mariadb` only when the operator deliberately selects it and the connector passes identical repository-contract tests.

Migration procedure to implement and rehearse before enabling this mode:

1. Define relational schemas/migrations reflecting the same stable IDs, schema versions, tenant ownership, uniqueness constraints and record relationships as the file store.
2. Add a MariaDB implementation for the **same** repository interfaces. Keep business services, HTTP APIs, chart data contracts and Rust engine unchanged.
3. Build a versioned export/import utility with dry-run, record counts, integrity checksums, relationship checks, secret-handling policy and audit report. Export must never log or expose raw credentials.
4. Stop or freeze writes, produce and verify a consistent file-store snapshot/checkpoint, import into a clean database, then compare ownership, revisions and counts and run complete integration/authorization tests.
5. Switch the configured adapter in a **staging** environment first; exercise login, token revocation, layouts, synthetic definitions, and cross-tenant access tests.
6. Use a controlled maintenance window to cut over, retaining the verified file snapshot for rollback. Do not casually toggle adapters against divergent live stores or start unsupervised dual-writes. Define the recovery plan before migrating live data.
7. MariaDB contract tests run as a separate **optional integration CI job** (service container or provisioned test instance); the default file-based test suite stays fully database-free.

**Decision trigger:** move application metadata to MariaDB when real-world transactional concurrency, audited production credentials, billing, or multi-instance consistency justify it. Do not migrate market tick/candle WAL and binary segment history merely because the application store changes.

### Proposed private file-store layout

~~~text
private-storage/
  app-dev/
    journal/operations.wal
    snapshots/<checkpoint>.json
    indexes/
    tenants/<tenant-id>/
      users/
      workspaces/
      synthetic-definitions/
      settings/
    test-fixtures/
  market/
    ... (see Rust market storage layout above)
~~~

The file-backed store is deliberately a **development/test implementation**, not a claim of production ACID equivalence to MariaDB.

### Write path and acknowledgement semantics

1. Validate schema, timestamp quality, source entitlement, and instrument identity.
2. Assign local ingest sequence and deterministic deduplication key **when upstream identifiers permit**. Preserve original source details; do not invent exchange-trade IDs.
3. Update the hot quote/synthetic/candle state in instrument order.
4. Publish eligible realtime observations without waiting for disk where the API contract explicitly labels them *volatile*.
5. Submit retained events and completed candles to a **bounded** single-writer queue. Append checksummed, length-framed records to WAL.
6. Acknowledge **durable** operations only after the configured WAL flush/fsync durability point.
7. Periodically checkpoint snapshots; write new immutable segments and indexes, fsync and atomically publish manifests.

**Critical distinction:** delivered realtime market updates may be volatile; a confirmed saved user setting, order/audit operation or durable history write must not be acknowledged as committed before its configured durable commit. A full writer queue must result in backpressure, rate shaping or an explicit degraded state—never silent corruption.

### Recovery, integrity and retention

- WAL records contain format version, length, sequence, checksum and enough source metadata for deterministic replay.
- On boot: verify the latest snapshot, replay valid WAL records, truncate only incomplete/uncommitted tails using an explicit recovery policy, and rebuild corrupt indexes from verified blocks.
- Use monotonically versioned immutable manifests; publish snapshot/index replacements by write + sync + same-filesystem rename + directory sync where supported.
- Prevent unbounded growth through rotation, compaction, quotas and source-specific retention rules.
- Encrypt credentials and restricted data at rest; separate keys from the storage directory. Protect disk data outside the public web root.
- Back up consistent snapshots **plus their required WAL range** off-server. Test restorations and recovery point objectives.
- Historical persistence and cross-user dissemination are gated by the actual broker/exchange licensing agreement.

## 6. Market-data contracts and synthetic correctness

Define versioned contracts independent of Upstox/OpenAlgo wire messages.

**Normalized market event (minimum fields):**
source_id, entitlement_scope, instrument_id, event_type (ltp/quote/depth), exchange_ts (nullable), source_ts (nullable), recv_ts, ingest_seq, price/size fields, flags (stale, delayed, inferred, corrected), schema_version. Upstream event IDs / exchange sequence are optional—not guaranteed by every provider.

**Candle:** series_id, start_ts, end_ts, session/calendar, timeframe, O/H/L/C, volume (nullable), is_final, source_quality, formula_version (for synthetics), actual component contract IDs/weights, revision.

- Synthetic price S(t) is computed from **time-aligned observations of every constituent** at a defined valuation rule. Track staleness, arrival order and late events.
- Synthetic OHLC high and low must be derived from the observed synthetic price series. **Never** sum independent CE-high + PE-high or CE-low + PE-low as if simultaneous.
- Distinguish fixed ATM, rolling ATM and scheduled re-centering. Strike rolls form explicit, auditable series transitions.
- Where only aggregated historical component candles exist, label reconstructed synthetic highs/lows *approximate*; do not imply tick-accurate history.
- A broker's streamed quote updates are not necessarily an exchange-complete tick-by-tick feed; label provenance honestly.
- Shared calculation and caching are restricted to compatible entitlements. Never pool BYOK users' feeds into a general redistributed feed without rights.

## 7. Security and tenancy

- Tenant-scoped user IDs, **multiple linked broker account IDs per QSYN user**, broker sessions, secrets, entitlement decisions, synthetic definitions, files and cache keys. Every broker-linked event must retain its `account_id` and source-entitlement scope.
- Server-side encrypted broker credentials when explicitly enabled for a production-approved store; use fake/sandbox credentials in the default file-backed dev/test profile. No API key, broker secret or OpenAlgo token in chart browser bundles.
- Short-lived, scope-bound chart access tokens minted by PHP; Rust validates tenant/series/expiry on subscribe and refresh.
- Per-tenant connection limits, rate limits and bounded outgoing buffers; slow viewers cannot stall the upstream engine.
- Dedicated admin and execution permissions; paper-trading first, live trading behind explicit enablement and pre-trade risk checks.
- Logs and backups must not expose raw secrets; maintain revocation and audit trails.
- Legal review for OpenAlgo AGPL-3.0 obligations, OpenAlgo Charts Apache-2.0, and market-data licensing before commercialization.

## 8. Deployment: Cloudways-first, capability-gated

Logical applications:
- PHP site (public HTTPS, OpenAlgo Charts static assets, auth and REST API).
- OpenAlgo (Python process, private APIs and broker connectivity).
- Rust daemon (private feed ingest, history API and outbound WSS gateway).

These may share a Cloudways Flexible machine **only if tested and permitted**: compatible Python runtime, stable long-running Rust/Python process management and restart, Nginx/WSS proxying, network/port access, TLS, storage/IO and safe resource isolation. Creating three "applications" in Cloudways does not itself satisfy these conditions. If any gate fails, retain PHP on Cloudways and move Rust/OpenAlgo to a dedicated execution host without changing the logical architecture.

No production Node.js process is needed. Compile OpenAlgo Charts assets in CI. Keep OpenAlgo/Upstox endpoints private; expose only signed viewer endpoints to the public internet.

## 9. Upstream maintenance and compatibility program

**Sources to monitor:**
- https://github.com/marketcalls/openalgo/releases
- https://github.com/marketcalls/openalgo/commits
- https://github.com/marketcalls/openalgo-charts/releases
- https://github.com/marketcalls/openalgo-charts/commits
- https://www.npmjs.com/package/openalgo-charts

**Pipeline:**
1. Daily/scheduled GitHub Actions check for new releases and meaningful commits; Dependabot/Renovate for the chart package, where applicable.
2. Record baseline version/SHA, changelog, migration flags and known issue links. Create upgrade PR; do not track unpinned upstream main in production.
3. Run static/license/security scan, broker API contract tests, simulated V3 feed tests, Rust feed/replay tests, chart API tests and UI screenshots.
4. Verify existing stored WAL/snapshot/segment versions are readable; test migration from the previous schema and disaster restore.
5. Run load/latency tests, tenant entitlement tests and staging smoke tests.
6. Require production approval for upstream changes that impact schema, API contracts, credential handling, trading, or exchange feed behavior. Use canary/rollback where possible.
7. Archive tested upstream version pairs and release notes. New upstream features are enabled in QSYN only after integration work when needed.

**Never** assume an upstream update automatically exposes every new feature in QSYN. Compatible library upgrades can be largely automatic; new flows and breaking changes require adaptation. Database migrations need backups and potentially a forward recovery plan if rollback is not safe.

## 10. Phase-wise implementation plan and exit criteria

| Phase | Scope | Required exit evidence |
| --- | --- | --- |
| **0 — Blueprint & feasibility** | Confirm licensing, Cloudways process/WSS support, OpenAlgo interfaces; define pluggable PHP store contracts and file-only default CI; dependency pins | Hosting smoke test; no-MariaDB CI pass; adapter-contract fixtures |
| **1 — PHP identity & control** | Multi-user test identities, private file-backed repository adapter, **one-to-many linked broker accounts**, authentication, mocked broker credentials, roles and entitlements; MariaDB optional adapter stub | One test user links two Upstox mocks and one other broker; tenant/account isolation tests pass with MariaDB/Redis absent |
| **2 — Upstox / OpenAlgo** | Initial Upstox linkage followed by a **second separately authorized Upstox account** with isolated OpenAlgo instance; symbol/expiry lookup, quotes, history and reconnection | Two Upstox accounts can be selected, monitored and disconnected independently; chart source provenance verified |
| **3 — Rust engine + storage foundation** | Normalized feeds, subscription registry, tick/price processing, candle builder, memory cache, checksummed WAL, snapshot replay, file segments/indexes | Deterministic replay, power-loss/crash recovery tests, observable end-to-end metrics |
| **4 — OpenAlgo Charts terminal** | Supported widget/grid/data-feed integration; indicators, drawing/layout persistence, candle history and realtime WSS | Live and historical chart parity, saved workspace recovery |
| **5 — Synthetic Studio (MVP)** | ATM straddle/strangle, weighted formula engine, rolling/fixed strikes, synthetic candles and backfills | Replay-proven synthetic OHLC, clearly labeled approximate reconstructions |
| **6 — Multi-user and multi-provider** | Scale linked accounts across independent QSYN users; integrate additional brokers through isolated OpenAlgo contexts; authorized fan-out; account health, rate and worker limits | Two Upstox accounts plus at least one different broker validated concurrently; isolation/compliance and load-test gates pass |
| **7 — Alerts and options analytics** | Upstream option analytics reuse, Greeks/OI, premium spikes, server-side alerts | Correct alert timing and browser-off delivery |
| **8 — Trading and risk** | OpenAlgo sandbox, positions/orders, privileged execution API, risk checks | Paper-trading acceptance, explicit production go/no-go |
| **9 — Production hardening** | Benchmarks, backups, observability, disaster restore, upgrades, capacity tuning | Agreed SLOs, recovery tests and production readiness sign-off |

Phase 3 includes the market-data storage engine—not a separate Go storage service. Historical file-format v1, migration tests and restore tooling must exist before production history retention. The PHP application file-store interface begins in Phases 0–1. MariaDB may be added later through an independently tested adapter and migration without revising Rust market-data storage.

## 11. Engineering targets (unverified until measured)

- Internal Rust processing (receipt -> calculated update): goal p99 < 10 ms for representative active instruments, excluding upstream delays, network and client drawing.
- In-memory hot lookup: goal < 1 ms.
- Indexed local SSD read: goal < 5 ms for an appropriately bounded block read; broad ranges may take longer.
- Interactive history query: goal p95 < 50 ms for agreed query sizes, excluding network.
- Browser refresh policy may coalesce visual updates while still processing and recording all permitted source events internally.
- All latency/throughput claims must include workload, active instruments, client count, disk/fsync mode, payload size and loss metrics.

These are **acceptance targets**, not claims about Upstox, Cloudways, OpenAlgo or the eventual QSYN deployment.

## 12. Architectural decision record

| ID | Decision | Status |
| --- | --- | --- |
| ADR-001 | QNXT is separate; do not mix code/servers/data | **Fixed** |
| ADR-002 | Reuse OpenAlgo and OpenAlgo Charts via supported interfaces | **Fixed** |
| ADR-003 | Rust/Tokio owns hot market-data processing and file storage; no separate Go engine | **Fixed** |
| ADR-004 | File-based WAL/indexed binary market history; no SQL/Redis in tick hot path | **Fixed as design**, benchmark before launch |
| ADR-005 | No MariaDB in QSYN development or default CI; file-backed PHP application repository; optional MariaDB adapter + controlled migration when selected | **Fixed for dev/test; migration optional** |
| ADR-006 | Preserve OpenAlgo SQLite/DuckDB internals | **Fixed** |
| ADR-007 | Multiple user keys must be isolated; pooling/redistribution requires licenses | **Fixed** |
| ADR-008 | Cloudways-first, with persistent-daemon feasibility gate | **Pending validation** |
| ADR-009 | Upstream upgrades are monitored, pinned, tested and staged; no blind auto-deploy | **Fixed** |
| ADR-010 | Broker V3 Upstox starts the platform; add other adapters later | **Fixed** |
| ADR-011 | Real credentials, live trading and production billing are disabled in file-backed development profile until separately reviewed and approved | **Fixed** |
| ADR-012 | Reusable repository contracts and repeatable file→MariaDB import/verification/rollback procedure are mandatory before switching | **Fixed** |
| ADR-013 | One QSYN user can link multiple Upstox accounts and other broker accounts; each authorization/feed/order context is isolated | **Fixed requirement; not implemented** |
| ADR-014 | No broker account's market data may be used to service unrelated users absent verified redistribution rights | **Fixed** |
| ADR-015 | Browser Start/Stop/Restart of qsyn-stream requires an authenticated admin control plane, a restricted provider-approved service manager, CSRF protection and explicit opt-in; no public shell execution | **Implemented as disabled-by-default interface; Cloudways process manager unverified** |

### Phase 0 administrator-only Rust runtime control

QSYN has an opt-in web administration interface for the single hardcoded program `qsyn-stream` at `/qsyn/admin/rust`, with Start, Stop, Restart, manager status and Rust health. It is deliberately disabled by default. Enabling requires a server-managed administrator password hash, secure PHP sessions and CSRF, and provider-approved **restricted** Supervisor control scoped only to QSYN; it never runs arbitrary commands supplied by the browser. Cloudways' ability to grant those permissions has not been verified. `QSYN_CONTROL_ENABLED=1` alone does not start Rust. Detailed configuration and restrictions are in `infrastructure/DIGIOPS.md`.

## 13. Open launch gates and current implementation status

**Not yet verified:** multi-tenant multi-account broker authorization/compliance and static-IP rules; the resource cost of multiple OpenAlgo contexts; Cloudways daemon viability; Upstox live-feed latency; production data licenses/derived-data rights; tenant-scale OpenAlgo topology; actual hardware sizing; full WAL crash recovery; end-to-end chart integration; file-backed application-store concurrency/recovery; MariaDB adapter migration and cutover (not yet required).

**Phase 0 implemented so far:** PHP development terminal, simulated chart feed, OpenAlgo Charts bundle, Rust synthetic calculation foundation, compiled Rust health/demo WebSocket executable, file-store scaffold, GitHub Actions tests and DigiOps release packaging. Administrator-only runtime control interface is implemented but disabled until Cloudways provisions a restricted service manager. **Not implemented:** live Upstox OAuth/feed, real multi-user accounts, production trading, complete file WAL/recovery, optional MariaDB adapter/migration, verified persistent Rust daemon startup and management on Cloudways. Implementation begins at Phase 0, following this document.

## Primary upstream references

- OpenAlgo: https://github.com/marketcalls/openalgo
- OpenAlgo official docs: https://docs.openalgo.in/
- OpenAlgo Charts: https://github.com/marketcalls/openalgo-charts
- OpenAlgo Charts package: https://www.npmjs.com/package/openalgo-charts
- Upstox developer platform: https://upstox.com/developer/api-documentation/

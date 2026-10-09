# QSYN — Master Architecture Blueprint v1.2

**Status:** Architecture baseline for implementation; deployment and licensing gates remain open  
**Updated:** 2026-10-09  
**Repository:** https://github.com/indigiti/qsyn  
**Supersedes:** Blueprint v1.1 and the prior storage proposal in chat

> This document is the canonical QSYN architecture. A completed item must be backed by code, tests, and deployment evidence. Statements marked "proposed", "target", or "pending" are not deployed capabilities.

## 1. Purpose and non-negotiable design rules

QSYN is a multi-user Indian-market charting and synthetic-instrument platform, initially using Upstox, OpenAlgo, and OpenAlgo Charts. The core use cases are realtime NIFTY/options charts, ATM straddles/strangles, multi-leg premium baskets, configurable synthetic indices, saved workspaces, and eventually trading.

1. Reuse maintained OpenAlgo/OpenAlgo Charts interfaces and features before implementing alternatives.
2. Keep QSYN's custom code, data contracts, accounts, and storage independent from upstream internals.
3. Treat QSYN and QNXT as entirely separate projects; QNXT is not a dependency.
4. Process realtime ticks in Rust memory without forcing them through PHP, MariaDB, Redis, or RabbitMQ.
5. Use **file-based storage for QSYN market-data history**; do **not** remove OpenAlgo's native databases or transactional storage for QSYN user accounts.
6. No production Node.js server. Build-time JavaScript/TypeScript tooling may run in CI.
7. Do not share one user's broker data with others without verified provider/exchange permissions.
8. Keep order execution and credential management isolated from public chart broadcasting.
9. All upstream upgrades must be pinned, tested, staged, approved, and rollback-ready.

## 2. Frozen stack and ownership

| Area | Baseline | Owner / boundary |
| --- | --- | --- |
| Initial broker | Upstox market-data APIs | Broker contract and entitlements |
| Broker abstraction, orders, upstream history/options | OpenAlgo (Python) | Upstream-managed integration; avoid core forks |
| Realtime ingestion, normalization, synthetics, candles, fan-out | Rust + Tokio | QSYN-owned service |
| Chart rendering, indicators, drawings, layouts, replay UI | OpenAlgo Charts (JS/TS) | Upstream library + QSYN feed adapter |
| Main website and auth API | PHP 8.2+ application | QSYN-owned |
| User/account/broker metadata and transactional records | MariaDB | QSYN-owned transactional store |
| Volatile caches/rate limits where justified | In-process Rust cache; Redis optional | Not in the market-data critical path |
| Background admin jobs | PHP workers / Supervisord where supported | RabbitMQ optional |
| Market tick/candle history | Append-only WAL + immutable indexed binary segments | QSYN Rust storage |
| OpenAlgo own persistence | Existing SQLite / DuckDB as supplied upstream | Do not replace or manipulate directly |
| Preferred hosting | Cloudways Flexible, subject to persistent-process validation | Alternative execution host allowed for Rust/OpenAlgo |
| CI and dependency maintenance | GitHub Actions + dependency-update tooling | QSYN-owned |

**Rationale for hybrid storage:** "Database-free" is scoped to QSYN's high-frequency market-data path. OpenAlgo's current README describes SQLite operational stores and a DuckDB Historify store; retain these to preserve upstream upgradeability. Accounts, payments, entitlements, secrets metadata, and trading/audit records require transactional guarantees: MariaDB remains the baseline. Rust, not Go, implements the QSYN market-data file engine.

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

## 5. Storage architecture v1.2 (hybrid, memory-first)

| Data class | Canonical storage | Reliability rule |
| --- | --- | --- |
| Latest ticks, current candle, source health | Rust bounded in-memory structures | Ephemeral; rebuild on reconnect/recovery |
| Optional retained raw feed events | Checksummed append-only WAL / binary blocks | Subject to licensing and retention policy |
| Completed ordinary candles | Date/instrument/timeframe partitioned immutable binary blocks | Indexed range reads; verified publishing |
| Completed synthetic candles | Versioned synthetic-series binary blocks | Preserve leg mapping, formula, roll rules |
| Active synthetic definitions | MariaDB metadata + versioned JSON export | Transactional updates, audited |
| Workspace/drawing documents | MariaDB metadata; JSON documents/exports where useful | Auth-scoped updates and atomic publishing |
| Users, roles, entitlements, sessions, key metadata | MariaDB; secrets encrypted with managed application key | ACID operations, revocation, audit |
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

- Tenant-scoped user IDs, broker sessions, secrets, entitlement decisions, synthetic definitions, files and cache keys.
- Server-side encrypted broker credentials; no API key, broker secret or OpenAlgo token in chart browser bundles.
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
| **0 — Blueprint & feasibility** | Confirm licensing, Cloudways process/WSS support, OpenAlgo interfaces; CI skeleton, dependency pins and storage contract | Hosting smoke test, decision log, CI baseline |
| **1 — PHP identity & control** | Multi-user account model, MariaDB, auth, secret vault, admin and entitlement model | Two accounts cannot read or use each other's keys or data |
| **2 — Upstox / OpenAlgo** | First broker linkage, symbol/expiry lookup, quotes, historical feeds, reconnection | Authenticated live quotes and authorized historical candles |
| **3 — Rust engine + storage foundation** | Normalized feeds, subscription registry, tick/price processing, candle builder, memory cache, checksummed WAL, snapshot replay, file segments/indexes | Deterministic replay, power-loss/crash recovery tests, observable end-to-end metrics |
| **4 — OpenAlgo Charts terminal** | Supported widget/grid/data-feed integration; indicators, drawing/layout persistence, candle history and realtime WSS | Live and historical chart parity, saved workspace recovery |
| **5 — Synthetic Studio (MVP)** | ATM straddle/strangle, weighted formula engine, rolling/fixed strikes, synthetic candles and backfills | Replay-proven synthetic OHLC, clearly labeled approximate reconstructions |
| **6 — Multi-user and multi-provider** | Isolated broker accounts, permissions, permitted sharing, additional brokers, fan-out scaling | Credential/entitlement isolation and load-test gates |
| **7 — Alerts and options analytics** | Upstream option analytics reuse, Greeks/OI, premium spikes, server-side alerts | Correct alert timing and browser-off delivery |
| **8 — Trading and risk** | OpenAlgo sandbox, positions/orders, privileged execution API, risk checks | Paper-trading acceptance, explicit production go/no-go |
| **9 — Production hardening** | Benchmarks, backups, observability, disaster restore, upgrades, capacity tuning | Agreed SLOs, recovery tests and production readiness sign-off |

Phase 3 includes the market-data storage engine—not a separate Go storage service. Historical file-format v1, migration tests and restore tooling must exist before production history retention.

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
| ADR-005 | MariaDB remains for user-facing transactional data and credentials metadata | **Fixed for v1** |
| ADR-006 | Preserve OpenAlgo SQLite/DuckDB internals | **Fixed** |
| ADR-007 | Multiple user keys must be isolated; pooling/redistribution requires licenses | **Fixed** |
| ADR-008 | Cloudways-first, with persistent-daemon feasibility gate | **Pending validation** |
| ADR-009 | Upstream upgrades are monitored, pinned, tested and staged; no blind auto-deploy | **Fixed** |
| ADR-010 | Broker V3 Upstox starts the platform; add other adapters later | **Fixed** |

## 13. Open launch gates and current implementation status

**Not yet verified:** Cloudways daemon viability; Upstox live-feed latency; production data licenses/derived-data rights; tenant-scale OpenAlgo topology; actual hardware sizing; full WAL crash recovery; end-to-end chart integration.

**This commit is documentation only.** It does not implement a Rust engine, PHP website, Upstox credentials, chart terminal, storage files, CI automation or Cloudways deployment. Implementation begins at Phase 0, following this document.

## Primary upstream references

- OpenAlgo: https://github.com/marketcalls/openalgo
- OpenAlgo official docs: https://docs.openalgo.in/
- OpenAlgo Charts: https://github.com/marketcalls/openalgo-charts
- OpenAlgo Charts package: https://www.npmjs.com/package/openalgo-charts
- Upstox developer platform: https://upstox.com/developer/api-documentation/

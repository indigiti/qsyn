# QSYN — implementation audit & remaining exit gates

Audit date: **2026-10-10**, timezone Asia/Kolkata. Baseline: deployed-by-operator **QSYN #99**, GitHub `main` SHA `7cbb68db8843c767bfa4277563ef323a28be4305`, DigiOps artifact `11667625827`. CI and DigiOps downloaded-artifact checks passed at that SHA. A reported Cloudways deployment is **not** independent evidence of network reachability, actual running PHP-FPM environment or market permissions.

**UI preservation requirement:** Keep the already integrated upstream OpenAlgo Charts interface, its toolbar, layout, indicator menus, chart semantics and upstream styles **unchanged**. Do not copy/reimplement OpenAlgo's separate trading application, replace widget controls, or extend the QSYN frontend for this backend audit. The original OpenAlgo application at https://github.com/marketcalls/openalgo is not a QSYN Git submodule and must never be modified by a QSYN backend PR. This branch intentionally modifies **no** `frontend/` or `apps/web-php/public/` files.

## Evidence-based blueprint audit

| Blueprint phase | Verified source/baseline | Exit status | Incomplete required acceptance |
|---|---|---|---|
| 0 · architecture / CI | PHP routing, simulated Rust HTTP/WS, OpenAlgo Charts integration, DigiOps package, staged release manifest | **Source complete for development; Cloudways operational acceptance partial** | Public external probes, resolved HTTP 403, verified restricted service manager, rollback drill |
| 1 · identity/control | Private test-only session/CSRF, tenant user records, mock broker links (two Upstox plus one mock other broker), account/workspace/audit checks | **Development fixtures implemented; real private acceptance pending** | Separate Cloudways app, PHP-FPM config, 2-network VPN/ACL attestation, password/secret security sign-off |
| 2 · Upstox/OpenAlgo | Private **CLI-only** OpenAlgo quote/chain probe, local Upstox BOD JSON inspector | **Partial** | Real OAuth/token lifecycle, per-account isolated OpenAlgo contexts, actual instrument and entitlement verification, independent Upstox A+B quotes, reconnect |
| 3 · Rust engine/storage | Synthetic OHLC processing, scoped normalized quote engine, test JSONL journal; this branch adds framed fsync WAL, immutable indexed binary candle partitions, scoped offline replay and CLI recovery checks | **Offline reusable components; production engine incomplete** | Actual broker transport, subscription registry, source timestamps, persistent worker wiring, crash/restart/volume benchmarks, snapshot/retention/backup and HA |
| 4 · OpenAlgo charting | Four-leg OpenAlgo widget charts, chart-first QSYN terminal, responsive menus, layouts saved locally | **Simulated UX implemented; live chart exit incomplete** | Entitled live/history feed, authorized WSS subscriptions, drawing/workspace recovery across devices and chart-parity tests |
| 5 · Synthetic Studio | CE/PE basket/straddle/strangle, sampled synthetic premium candles and hypothetical payoff, up to 4 visible leg charts | **Simulated MVP only** | Real fixed/rolling ATM instruments, real contract transitions, aligned live ticks and historical backfill, approximation/confidence labels |
| 6 · multi-user/multi-provider | Mock broker-account repository and account-scoped test charts | **Production pending** | Two separately authorized Upstox accounts + distinct broker concurrently, per-user legal permissions, isolated feed workers and load/rate testing |
| 7 · analytics & alerts | Educational fixed-vol Greeks, sampled payoff, replay, browser foreground alerts | **Simulation only** | Provider IV/OI, live Greeks validity checks, account-owned server-side alert scheduler, browser-off delivery |
| 8 · trading/risk | Browser-only fictional position journal / mark P&L | **No real OMS** | Durable paper OMS, margin/exposure policies, order lifecycle/audit, provider sandbox certification; real orders only after explicit approval |
| 9 · production hardening | Basic GitHub tests, deployment packaging and operational runbooks | **Pending** | Measured SLOs, authenticated observability, failover, encryption/key rotation, backup/restore, security testing, rollback |

The `docs/MASTER_BLUEPRINT.md` Phase 13 status narrative predates the recent chart and synthetic releases; **phase exit status must be based on verified acceptance evidence, not historical prose or the number of deployed artifacts.**

## Backend additions in this audit branch (offline, zero UI changes)

- `services/stream-rust/src/durable_market_wal.rs`: framed/CRC32 20-byte-header WAL records, monotonically increasing writer sequence, fsync before durable-ack return, owner-only absolute-root/path safeguards, nonblocking exclusive writer lock, strictly bounded scanner and tenant/account/source/entitlement-scoped filtered history. Corrupt bytes, invalid sequence/schema and partial final frame deny regular reads.
- `services/stream-rust/src/immutable_candles.rs`: immutable per-series+month binary candle partition, serialized source scope+mode metadata checked at read time, per-row CRC, bounded O(log N) time index lookup through fixed row offsets, entire partition CRC/order audit, owner-only file and atomic hard-link publish. No destructive overwrites.
- `services/stream-rust/src/offline_rebuild.rs`: read verified scope-matching WAL quotes, sort source timestamps, use the synchronized `ScopedBasket` to reconstruct synthetic candles, omit the last unfinalized minute, publish a verified immutable partition, reject `authorized_live` use without a real entitlement pipeline.
- `services/stream-rust/src/bin/qsyn-market-archive.rs`: strictly offline operator CLI for WAL status; repair of **only** a torn final frame requires `QSYN_ARCHIVE_REPAIR_APPROVED=1`. CRC corruption and mid-file sequence violations cannot be repaired automatically.
- `services/stream-rust/tests/market_archive_cli_smoke.py` and Rust unit/regression tests exercise real disk fsync, exclusive writer conflict, corrupted/torn WAL denial, explicit recovery, fixed-offset queries, cross-account rejection, synchronized replay correctness, and serialized CLI output sanitization.
- DigiOps release includes an additional private operator binary; does not launch it as a daemon or expose any route.

**Do not claim full production WAL, indexed multi-day history, snapshots, catch-up/reconciliation, continuous feed, disaster recovery or exchange-approved retention from these additions.** CRC32 is an accidental-corruption detector, not HMAC, authenticated encryption, a compliance ledger or a signature.

## Immediate high-priority external work, in dependency order

1. **Private broker environment and legal entitlement**: provision the physically isolated OpenAlgo/Upstox contexts, test actual OAuth renewal, authorized market-data rights, timestamps and live-only-to-authorized-user license conditions. Two independent Upstox A/B linked identities must prove separation; no token should enter GitHub, PHP public routes or browser bundles.
2. **Actual Upstox V3 gateway**: separately implement an authenticated private binary Protobuf WebSocket decoder and stateful recovery/subscription limits. It must map official instrument keys and preserve source, exchange and receive timestamps. Do not treat the present loopback quote probe as a streaming feed.
3. **Rust integration**: connect authorized private V3/OpenAlgo adapters to scoped market engine and WAL; enforce packet sequencing, backpressure, source freshness/staleness, entitlement-scoped fanout, source-switch isolation and market-hours/calendar-aware backfill.
4. **Authorized chart history and lifecycle**: tie live WSS + historical candle APIs to tenant-scoped subscriptions; verify real fixed/rolling synthetic CE+PE historical candles and monitor approximate reconstructed extrema.
5. **Trade subsystem**: add a server-owned paper OMS with durable intents, risk checks, replay and audit, then independently approve broker sandbox and only later live trading. Never implicitly promote browser paper positions to real orders.
6. **Operations**: separate private Cloudways host with ingress ACL, PHP-FPM state, exact deployed code/runtime attestation, tested backups/restore, rollback, credentials lifecycle, monitoring, SLO and load test.

## Operator-only archive diagnostics

After installing a DigiOps artifact from this branch, create a **separate owner-only 0700 directory outside webroot** for offline/authorized data. There is no reason to enable account fixtures or live trading. The binary is never automatically executed by the web app or public Rust listener.

```sh
private/app/bin/qsyn-market-archive audit /absolute/private/market-wal
# Only if a corruption-free valid-prefix scan reports an incomplete final frame,
# after a verified backup and specific operational approval:
QSYN_ARCHIVE_REPAIR_APPROVED=1 \
  private/app/bin/qsyn-market-archive repair-torn-tail /absolute/private/market-wal
```

Audit output contains counts/bytes/sequences only; no customer data, broker keys or private paths. The CLI does not create the root itself or start a feed. The operator must back up the original WAL prior to repair and re-audit after.

## Acceptance criteria

**GitHub (can automate):** green PHP, Chromium/OpenAlgo, Rust clippy/unit/smoke, market WAL + replay regression, DigiOps build/verified artifact; changes restricted to Rust domain, new tests, workflow packaging and this documentation. Existing `/qsyn/studio` and OpenAlgo frontends untouched.

**Cannot be automated in GitHub:** real broker authorization, Cloudways service/ACL validation, external internet/staging reachability, live user entitlements, actual device/browser behavior, production data-retention licensing, end-to-end latency targets, real broker orders, or regulatory sign-off. These remain **pending**, not passed.

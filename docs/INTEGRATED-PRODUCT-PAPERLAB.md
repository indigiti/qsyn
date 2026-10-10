# QSYN Integrated Product Release — Market Pipeline, Replay, Analytics & Paper Lab

**Scope:** A substantial product-facing build in one branch, on top of deployed Options Studio #90. The application remains a **clearly labeled simulation**; the Rust library adds genuine domain processing code and a replay journal but not a deployed Upstox transport.

## Implemented

1. **Rust scoped normalized quotes.** A new private library component accepts normalized events with tenant, account, source, entitlement ID, instrument ID, source sequence, timestamp, mode and price. A multi-leg basket rejects foreign account/tenant/source/entitlement contexts, invalid prices, out-of-order sequences, stale component quotes, duplicate legs and source-mode mismatches. OHLC uses synchronized weighted prices. This is a reusable *domain boundary*, not authentication or a licensed feed adapter.
2. **Rust replay journal.** Test/development append-only JSONL events with an integrity checksum, fsync on each append, bounded validation and replay. Corruption is rejected. Checksums detect accidental edits and do **not** provide tamper-proof audit authentication. No assertion of crash-proof production WAL, indexed binary storage, compaction, snapshots, or retention guarantees.
3. **Studio theoretical analytics.** A separate PHP analytics model enriches the existing simulated candle response with signed educational delta, gamma, vega and theta, model assumptions (fixed 20% volatility, zero risk-free rate, fictional 7/14/30-day expiry), history drawdown, *sampled-range* maximum/minimum payoff and payoff breakevens. These are theoretical model values and are not actual implied volatility, market Greeks, complete financial risk, open interest or trading advice.
4. **Studio historical replay.** A browser slider and play/pause controls rewind the basket chart along the existing 120 fictional candles. Component panels retain full history and are labeled as such. No server daemon, historical exchange data, or replay quote streaming.
5. **Studio paper positions.** Explicit open/close actions maintain a fictional position journal and mark-to-market P&L in the current browser localStorage only, using simulated component closes. At most five open positions; a per-position max fictional premium of 20,000 points. A position can be closed only when its strategy definition matches the currently selected strategy. Paper opening while replay is rewound is blocked. No OMS, live broker gateway, real money, orders, margin, or settlement.
6. **Simulated foreground alerts.** Threshold alerts evaluate on strategy display or manual replay while the browser tab is active. Max eight per strategy. These are not background notifications, exchange alerts, server jobs, or reliable time-of-crossing signals.
7. **Truthful capabilities API.** Anonymous GET `/qsyn/api/v1/studio/capabilities` explicitly reports `market_data=simulated`, `broker_integration=not_connected`, `execution_enabled=false`, `live_trading_enabled=false` and `paper_orders_sent_to_broker=false`. Invalid POSTs remain 405; private identity/account features stay default-off.

Existing public `/qsyn/studio`, `/qsyn/`, mock-identity paths and Rust process manager are preserved. No new runtime env settings, public data-ingest endpoints, database, daemon, Supervisor restart or Cloudways provisioning are introduced.

## Acceptance

GitHub CI and DigiOps release must pass:
- PHP unit tests for signed model Greeks, scenario assumptions, breakevens and provenance.
- PHP HTTP tests for read-only studio API, broker-disabled capability contract, simulated analytics and disabled public account routes.
- Rust unit tests for scoped-quote rejection, synthetic highs/lows, integrity-replayed events and deliberate corruption.
- Chromium Studio browser tests covering opening/closing local paper positions, confirming journal provenance, alert creation, replay navigation/order guard and existing multi-chart workspace behavior.
- All existing PHP, Rust, browser and packaging jobs; stage and downloaded DigiOps artifact presence of `StudioAnalytics.php`.

**Live deployment to Cloudways is a separate operator action.** Source merge or green CI is not evidence of successful staging availability.

## Explicitly incomplete / needs independent authorization

- Actual Upstox OAuth and V3 Protobuf market transport; genuine NIFTY option instruments, expiries, settlement calendars, entitlements and live feed.
- OpenAlgo installation, broker account instance orchestration, per-account isolation and credentials; no private network endpoint has been approved for this integration.
- Connecting authorized ticks to the Rust library, private WebSocket gateway, signed viewer entitlements and permitted distribution.
- Production-grade WAL/indexed candle history, clock-skew handling, backfill/reconciliation, and high-availability continuity.
- Historical actual option-market prices, Greeks based on broker-supplied or implied volatility, exchange OI, production alerts.
- Authenticated persistent multi-user paper-trading or broker trading accounts; order management, risk, margin controls and financial compliance review.

Those capabilities must **not** be labeled complete or switched on from public test flags. Actual broker connection needs provider setup, authorized secrets, user-specific broker approvals and environment attestation; none are in this repo.

## Operator validation

After a verified DigiOps deployment, open `/qsyn/studio` and check:
- Risk model disclosure and four Greek cards appear with a populated scenario summary.
- Replay moves from bar 120 to an earlier snapshot and returns to the latest bar.
- Paper position opens and closes using fictional premium points, with no broker traffic.
- An alert can be created and a saved browser workspace remains available after reload.
- `GET /qsyn/api/v1/studio/capabilities` returns only simulated/disabled data.
- Public mock-account login and dashboards remain off; Rust diagnostic continues to declare real trading and Upstox disconnected.

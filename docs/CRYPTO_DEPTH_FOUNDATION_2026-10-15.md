# Crypto order-book depth foundation (opt-in)

Status: review-only, not activated on staging. This phase adds **read-only REST snapshots**, not incremental order-book streaming, a recording pipeline, or a heatmap. It is independent of QSYN's candle history, Indian indices, private feeds, broker authorizations and OMS.

## Safe contract

- Endpoint: `GET /qsyn/api/v1/crypto/depth?exchange=BINANCE&market=spot&symbol=BTCUSDT&limit=20`
- Exact allowlist: Binance spot/perpetual, BTCUSDT or ETHUSDT only.
- Response schema: `QSYN-PUBLIC-CRYPTO-DEPTH/1`; bid/ask prices, base-unit sizes and USDT notional, REST snapshot sequence, receipt time and age.
- Disabled by default. The existing admin dashboard under `/qsyn/terminal/operations` can enable/disable snapshots after a verified Rust upgrade using a private `0600` `crypto-depth.flag` stored in the shared persistent `QSYN_RUNTIME_DIR`. Rust reads this flag on every request, so no process restart is required. It is protected by the existing QSYN administrator session, strict origin checks and CSRF; it is not available from the homepage or public APIs. `QSYN_CRYPTO_DEPTH_ENABLED=1` remains a supervised-process startup fallback when no private flag exists, but private `0` overrides it.
- Maximum 100 upstream levels per side (fixed provider request); response is capped at requested 5–100 levels. One two-second cache per permitted instrument. A per-instrument mutex coalesces requests and prevents unbounded upstream fan-out.
- TLS only, fixed Binance URLs, fixed timeout and response-size cap. Malformed, empty, crossed or unsorted depth fails closed. No stale fallback after a failed refresh.
- No keys, credentials, private-account state or trading permissions; frontend bundles and original homepage are unchanged.

## Required follow-up before production

1. Verify Rust formatting, build, unit tests and the one-ELF artifact guard in GitHub CI. Perform a staging request with the flag absent (503).
2. On an authorized nontrading staging runtime enable the flag, verify spot and perpetual snapshots against direct Binance feeds, stale/invalid/failure behavior and response-size budgets. Do not infer actual performance from unit tests alone.
3. Measure concurrent requests, upstream rate limits, memory use and snapshot latency. Confirm exchange market-data redistribution terms for the intended deployment.
4. A *separate* reviewed phase may add synchronized Binance diff-depth WebSockets: buffer deltas during REST snapshot, validate sequence boundaries, resynchronize after gaps/reconnects, publish only coherent books and record real observed depth with explicit gaps. Do not treat REST snapshots as a continuous feed or paint fabricated historical liquidity.
5. Only after live continuity evidence consider an optional chart heatmap and footprint. No additional Rust executable, web application, node service or dependency is needed for this phase.

## Operational boundaries

An exchange depth REST snapshot has a sequence identifier but is not a tick-by-tick stream. `received_at_ms` is **QSYN receipt time**, not an exchange-produced timestamp. The notional reported here is resting depth, not executed trade volume. Setting the feature flag on the existing Rust service is an operator-only change and is not part of this PR.

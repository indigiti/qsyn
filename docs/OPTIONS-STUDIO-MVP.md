# QSYN integrated Options & Synthetic Studio MVP

**Release scope:** Product-facing simulated-options development milestone combining the first working Options Studio user experience, static OpenAlgo Charts rendering, synthetic candle composition, hypothetical expiry payoff, and browser-local workspaces in one deliverable.

This is **not** the end of the complete master blueprint. There is no authenticated Upstox OAuth or licensed market feed, no option contract master, no production Rust subscription authorization, no real-time option quotes, no order routing, no brokerage connection and no portfolio risk acceptance. Never claim any such function from this release.

## How to use

Open **/qsyn/studio** (also linked from the existing /qsyn/ chart terminal). The page shows conspicuous simulation notices and allows:
- Switch between fictional NIFTY, BANKNIFTY and FINNIFTY price paths, with synchronized fake ATM/strike-step and 13 nearby demo strikes.
- Choose fake W1, W2 and M1 time horizons and 1-, 5- or 15-minute candle aggregation.
- Select ATM straddle or OTM strangle presets, or configure 1–4 synthetic option legs (CE/PE, BUY/SELL, strike and 1–5 notional units).
- Render OpenAlgo Charts canvases for the **combined unsigned premium basket** and the first two component contracts. Additional legs are still included in the basket and payoff.
- Inspect hypothetical expiry settlement payoff across 21 settlement scenarios and entry cashflow in **fictional points**.
- Save up to eight local browser strategy layouts and reload them, without activating the private user-account routes.

Premium candles use deterministic 15-second **time-aligned** component price observations; combined high/low are taken from samples of the actual synthetic basket. Individual leg candle highs/lows must **never** be added to create synthetic high/low. Trade action is ignored for the **premium-magnitude chart** and only affects the hypothetical profit/loss calculation. Candle volumes are zero because there is no exchange turnover. These values are not INR, and ignore lot size, fees, slippage, volatility, real expiry calendars and taxes.

## Public API contract (simulation only)

Both endpoints accept anonymous GET only and explicitly report `mode=simulated`, `broker_connected=false` and `trading_enabled=false`.

- `GET /qsyn/api/v1/studio/market?underlying=NIFTY` returns a fictional spot reference, ATM, grid step and CE/PE prices.
- `GET /qsyn/api/v1/studio/bars?underlying=NIFTY&expiry=W1&interval=1m&legs=<URL-encoded JSON>` returns 120 time-ordered OHLC bars, a simulated underlying series, up to four option-leg series, signed entry cashflow and payoff scenarios.

Example URL-encoded legs in decoded form:
```json
[
  {"type":"CE","side":"BUY","strike":24500,"qty":1},
  {"type":"PE","side":"BUY","strike":24500,"qty":1}
]
```
The strike must fit the chosen underlying's step and permitted range. The server rejects malformed JSON, unsupported symbol/horizon/interval, 0 or >4 legs, noninteger or out-of-range quantities, duplicate contracts, extraneous fields and attempts to submit account IDs. There are no POST actions. There is no symbol lookup outside three hardcoded **demo** underlyings.

The API is not market-data redistribution; it must not be used as a trading price feed or inserted into real trade decisions.

## Installation and verification

GitHub CI runs the PHP synthetic engine regression and Chromium integration browser smoke after bundling `frontend/dist/studio.js`. The DigiOps release carries the HTML, stylesheet, JS bundle and private PHP engine in existing artifact prefixes. No new server process, PHP extension, database, Rust restart, env switch or background job is required. Keep the existing mock-account flags off and leave trading off.

```sh
php apps/web-php/tests/SimulatedOptionsStudioTest.php
# after frontend npm install and npm run build, with Playwright installed:
cd frontend && node tests/browser-studio-smoke.mjs
```

Verify `/qsyn/studio` manually after DigiOps deployment, especially network routing and asset loading on Cloudways. A passing GitHub build does not prove deployment or authorise a real feed.

## Deferred master-blueprint gates

1. **Broker**: Upstox OAuth, per-account OpenAlgo process isolation, symbol/expiry master and market-data entitlements; broker and exchange approval.
2. **Market data**: normalized Rust actual quote ingestion, reconnection, short-lived authorized chart subscriptions, retained history with WAL/replay guarantees.
3. **Analytics**: genuine exchange option chain, Greeks/OI, liquidity metrics, alerts and time-aligned market-data synthetics.
4. **Trading**: sandbox/paper orders with risk limits and auditable confirmations; no live execution until further sign-off.
5. **Persistence**: secured multi-user workspaces and production-approved application store. Browser localStorage is explicitly **not** a tenant server-side record.

**No Phase 1 private-fixture flags should be turned on in the public environment to test this Studio.**

# QSYN Private Feed Phase — Bounded Reconnect & Synthetic OHLC

Baseline: `indigiti/qsyn` commit `a46f2c2085904fd1251da3b8166ccabd8ba2f4bd`, deployment #123 (operator-reported). This milestone advances private OpenAlgo market-data observation. **It is not a public live-chart release, continuously supervised broker daemon, licensed exchange feed or real trading activation.**

## Scope and implementation

The new Rust `private_live_pipeline` module uses QSYN's existing account-isolated private OpenAlgo WebSocket subscriber and `openalgo_stream::normalize`, then computes synchronized synthetic-premium OHLC from at most eight explicitly selected option legs. The algorithm:

- Authenticates the broker at the upstream loopback OpenAlgo WebSocket and checks the expected broker identity every session.
- Re-subscribes the exact instruments after each reconnect. Maximum four reconnects and 120 seconds total observation. Private API keys are taken from the pre-existing 0600 per-account registry only.
- Accepts finite positive LTPs with matching broker, exchange, subscribed instrument and tenant/account scope. Rejects future/stale, duplicate, out-of-order or invalid exchange timestamps. Quotes in a basket must be within the same minute and within 500 ms inter-leg timestamp skew by default.
- Computes OHLC from actual synchronized synthetic **observations**, never from separately aggregated constituent OHLC highs/lows. Rejected or incomplete events do not produce candles. The last still-forming minute is never claimed to be a finalized historical bar.
- Clears constituent quote cache and the incomplete candle on a disconnect, and records a feed gap. It never silently forward-fills quotes through a transport interruption or invents missed historical prices.
- Returns **diagnostic counts only** (authenticated sessions, reconnections, basket updates, finalized candles, rejects, detected gaps). It never returns raw quotes, options prices, API keys or customer details.
- Explicitly returns `public_feed_enabled=false`, `entitlement_attested=false` and `order_execution_enabled=false`. This code does not update the existing public `/qsyn/studio` or original OpenAlgo Charts UI.

## Usage after approved private OpenAlgo login

A private network-isolated OpenAlgo service must already be installed with a separately broker-authorized account and a verified subscription to the symbols. All keys and the registry must remain server-side, owner-only, 0600 and **outside** webroot. This is an operator-run **read-only diagnostic**, not a web route, recurring production daemon or exchange-entitlement grant.

```sh
export QSYN_PRIVATE_BROKER_GATEWAY=1
export QSYN_PRIVATE_FEED_PROBE_ENABLED=1
export QSYN_PRIVATE_FEED_RUNTIME_ENABLED=1
export QSYN_OPENALGO_REGISTRY_FILE=/ABSOLUTE/PRIVATE/openalgo-registry.json
# Use broker-verified, currently listed contracts; NEVER use a fabricated symbol:
private/app/bin/qsyn-openalgo-feed observe \
  tenant-approved owner-approved upstox-a \
  NFO:ACTUAL_CE_SYMBOL,NFO:ACTUAL_PE_SYMBOL
```

The existing `inspect` subcommand remains available and unchanged. A separate private `observe` flag is required; both execution flags (`QSYN_TRADING_ENABLED=1` and `QSYN_ENABLE_LIVE_TRADING=1`) block the operator command. The observation ends after at most 120 seconds. It is not automatically started by Supervisor, the web process or DigiOps.

## Verification and limitations

Rust unit and fake-provider WebSocket integration tests cover simultaneous-leg OHLC, missing-leg rejection, same-minute requirements, account isolation, duplicated timestamps, disconnect cache invalidation, upstream authentication, subscription and counter-only output. Existing PHP and Playwright browser suites must pass unchanged. DigiOps already packages the private `qsyn-openalgo-feed` executable; this update extends it without changing frontend assets.

Still pending:
1. Broker-owner login and provider subscription/data redistribution rights for each independent OpenAlgo instance. Never treat an OpenAlgo authenticated ping as exchange data entitlement.
2. Approved always-on worker supervision, bounded queues/backpressure, entitlement-scoped quote fanout, secure recoverable history and reconciliation on gap/reconnect.
3. Authorized per-user realtime WSS chart subscriptions, current instrument selection/strike-rollover calendar, historical backfill and testable staleness indicators.
4. Server-owned paper OMS, margin/position controls, audit, sandbox broker certification and separately approved real order execution.
5. Private Cloudways acceptance, backups, secrets rotation, recovery drill and measured latency limits.

**UI preservation:** No edits to `frontend/`, `apps/web-php/public/` or the upstream `marketcalls/openalgo` repository are authorized in this phase.

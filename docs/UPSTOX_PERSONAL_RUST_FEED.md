# QSYN personal Upstox — Rust-only data path

QSYN is a **personal authenticated read-only terminal**, not a public market-data distributor.

## Actual provider path

`Admin → Upstox Token` securely stores the one-year Upstox Analytics Token
as an account-bound 0600 private file. It is the **only** upstream credential
used for personal data. OAuth and manually provisioned index-worker plans
are **not** involved in this path.

The existing single deployed Rust `qsyn-stream` executable provides both:

- **1-minute historical bars:** the PHP admin API
  `POST /qsyn/api/v1/admin/upstox/personal-index/history` calls the
  existing Rust index-worker dispatch with the new `personal-history`
  operation. The Rust process itself loads the private token, calls Upstox
  V3 historical or current-day intraday APIs, validates the index symbol,
  price/time data, and returns up to 400 actual bars. PHP never supplies a
  token in a process argument.
- **Tick-by-tick WSS:** a browser with a real QSYN administrator session
  obtains a short-lived, one-use, symbol-scoped HMAC ticket from
  `POST /qsyn/api/v1/admin/upstox/personal-index/ticket`.
  The existing loopback Rust HTTP service serves
  `GET /ws/personal-index`. It verifies the ticket using the same
  server-side token, gets an **Upstox V3 one-use WSS redirect** with that
  Analytics Token, sends the official binary `ltpc` subscription, and
  decodes provider Protobuf frames. Exchange LTT timestamps drive the
  1-minute OHLC aggregator; zero index volume is not fabricated.
  Snapshot frames, stale/duplicate/out-of-order ticks, arbitrary symbols
  and malformed frames are rejected or ignored.

The browser never receives the Upstox token, upstream authorized WSS URL,
or direct server path. Browser closure aborts the upstream task.
Every reconnect obtains a fresh 35-second ticket and a fresh Upstox
one-use redirect. There is **no 12-second REST polling**.

## Host integration — no second service

The current Rust service is already intended to run on
`127.0.0.1:10251`. The existing public `.htaccess` contains an
**exact-path guarded** `mod_proxy_wstunnel` rule mapping

`wss://<site>/qsyn/ws/personal-index`
→ `ws://127.0.0.1:10251/ws/personal-index`.

If Cloudways blocks Apache websocket proxy upgrades, or its front nginx
does not forward the Upgrade/Connection headers, the browser will show
`RUST_UPSTOX_WEBSOCKET_UNAVAILABLE`. In that environment a Cloudways
ingress permission/proxy capability change is required; do **not** add a
second binary or disable administrator authentication. The app cannot
change a host-level reverse-proxy restriction through PHP.

The Rust runtime locates the same private `runtime` directory adjacent
to the existing deployed `app/bin` layout, unless
`QSYN_RUNTIME_DIR` is already set. The process must execute as the
same private runtime file owner; do not relax 0600 token permissions.

## Acceptance tests

1. Confirm admin-only Rust history returns real 09:15–15:29 IST candles
   for NIFTY and SENSEX on 2026-10-09, preserving exact exchange times.
2. On a trading day, open the chart with **Today** and verify the browser
   connects to `/qsyn/ws/personal-index` via WSS. The session is not
   'live' merely because a socket handshake succeeds.
3. Confirm actual `QSYN-RUST-PERSONAL-INDEX-TICK/1` packets, genuine
   ascending `time_ms`, and one-minute chart updates. Validate clean
   cancellation and automatic reconnect with a fresh ticket.
4. Confirm historical requests, WebSocket authorization and quotes do not
   require an OAuth callback, worker plan, separate daemon, extra linked
   Rust executable, public REST endpoint or trading permission.

Broker order routing remains disabled. Public NSE/BSE redistribution is not
enabled by this personal-data integration.

Official documentation:
- https://upstox.com/developer/api-documentation/v3/get-market-data-feed/
- https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3/
- https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/

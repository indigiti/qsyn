# QSYN — private Upstox chart grant renewal and reconnect

## Why this is needed

The Rust private-chart gateway validates a 30-second signed PHP viewer
grant every second. Previously the browser opened the socket only once,
so a successfully licensed NSE/BSE index or NSE_FO option chart went silent
when its ticket expired. A successful OAuth login by itself cannot open this
socket or grant exchange display rights.

## Revised frontend protocol (source only)

- Obtain current same-origin CSRF-authenticated PHP chart grant, scoped to
  the exact account and canonical NSE/BSE index or NSE_FO instrument key.
- Open the fixed-origin `/qsyn/private-chart/ws` endpoint and deliver the
  private signed viewer grant only in the first WebSocket frame (never URL).
- Validate Rust's `authentication_success` with matching expiry, then rotate
  to a new PHP grant and new socket at most 20 seconds after authorization,
  at least five seconds before expiry. Rust still performs independent
  active rights checks on every event.
- Upon network closure, reacquire a **fresh** scoped grant using bounded
  backoff (max five retries). An HTTP 401/403 entitlement denial stops
  reconnection immediately. On unsubscribing or React unmount, abort requests,
  cancel timers and close sockets. Preserve the exchange timestamp watermark
  across socket rotations and ignore duplicate provider snapshots.
- If WSS or authenticated feed is unavailable, display explicit failure; no
  demo candles, no public provider-quote fallback, no order execution.

The native Upstox V3 index worker still requires operator-attested, current
BOD instrument mapping, private display/retention rights, private runtime
and a correctly authenticated Cloudways WSS reverse proxy. This frontend
change does not set any permission flag or install that worker. Index
historical candles are **not** served by the existing NSE_FO history reader.

## Source and stage acceptance

1. Frontend unit tests must cover rotation before 30 seconds, new token on
   reconnection, canceled timers, explicit revocation and bounded retries.
2. Rust signed-grant/rights unit tests and PHP viewer-entitlement smoke tests
   must remain green. No public index OHLC endpoints become available.
3. With independently approved private staging rights, an operator must
   observe two or more authenticated socket rotations during open market,
   continued exchange-timestamped index ticks, rights revocation denial and
   no cross-account or simulation fallback.
4. No claim of actual index streaming, archival backfill or live trading
   should be made from passing CI alone.

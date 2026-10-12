# QSYN Core reset — first data-proof milestone

This branch deliberately avoids another full Terminal rewrite or fake live feed.

## Product boundary

Primary Terminal navigation now exposes only **Markets** and **Data Providers & Connections**.
All pre-existing routes remain supported as bookmarked/deep-link compatibility surfaces,
including workspaces, strategy, diagnostics, route management and administration.
No private runtime files, Rust modes or historical chart settings are removed.
The homepage OpenAlgo chart is unchanged.

## The smallest live-provider question

Under Data Providers & Connections → **Upstox access**, authenticated
administrators can test **NIFTY** and **SENSEX** separately with a selected completed
IST weekday using the stored read-only Upstox Analytics Token. No console, Rust
worker, signed chart grant or new credential is required for this test.

`GET /qsyn/api/v1/admin/upstox/index-history-proof` provides only status, CSRF
and the suggested previous weekday (it does not query Upstox).
`POST` accepts *only* `{ "confirmed":true,"symbol":"NIFTY"|"SENSEX",
"day":"YYYY-MM-DD" }`. Server-side scope restrictions prevent caller-selected
keys, URLs, authorization flags or token injection. It makes a single bounded
GET to the Upstox V3 historical-candle endpoint using one of two fixed **candidate**
keys, then validates OHLC and exchange timestamps with the existing adapter.

The response contains a provider HTTP code, bounded candle count, first/last UTC
timestamps, and a sanitized machine code, **never** OHLC prices, bearer tokens,
raw provider payloads, client IDs or account IDs. If the provider responds with
401, 403, 404, 422, 429, empty candles or malformed data, the response
distinguishes that outcome. A history success is **not** evidence of broker
profile identity, a current BOD attestation, exchange redistribution/display
rights, live WSS, or an operational index worker. Disable these checks with
`QSYN_INDEX_HISTORY_PROOF_ENABLED=0`.

Official references:
- https://upstox.com/developer/api-documentation/analytics-token/
- https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/

## Mandatory acceptance gate before chart cutover

1. From the *deployed* authenticated browser, run NIFTY and SENSEX proof on a
   known completed trading day; record the sanitized evidence (nonzero
   `candle_count`, actual first and last timestamps, HTTP 200).
2. If provider history is denied, resolve the actual credential/key/date issue.
   **Do not add dashboards, provisioning steps or Rust services as a workaround.**
3. Confirm the same operator's viewer-scoped NSE/BSE display rights before
   connecting private OHLC to the React chart. Existing public
   `/qsyn/api/v1/india/bars` must continue failing closed until lawful access.
4. Integrate **one** private data adapter into the existing chart and verify
   NIFTY/SENSEX symbol selection and reload using real candles. Only then
   reuse existing Rust binary for authenticated WSS live bars.
5. Remove or re-enable other Terminal features only when their own
   in-browser acceptance passes.

## Completion claims

Green GitHub Actions, a prepared plan, a stored token, and a working history
proof are each different milestones. None is equivalent to working Indian-index
charts. This PR only delivers the first provider-proof and navigation-scope
milestone. No live feed or chart candle is claimed.

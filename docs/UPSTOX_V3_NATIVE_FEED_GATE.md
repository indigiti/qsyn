# QSYN — Native Upstox V3 private binary feed milestone

**Status: source and offline regression tests only. No Upstox account connected, no actual CE/PE exchange timestamps verified, no Cloudways worker installed, no public chart subscription and no live orders.**

## Deliverable

`services/stream-rust/src/upstox_v3.rs` adds:

- Native, partial **official V3 protobuf** schema decoder for `FeedResponse`, `MarketInfo`, LTPC, market/index full feeds, and first-level-with-Greeks LTPC. All wire tags follow <https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto>; other fields are ignored rather than misinterpreted.
- The correct `sub` / `ltpc` subscription payload is encoded as **binary WebSocket bytes**, never a text frame. For this bounded CE/PE plan only two listed `NSE_FO|<instrument_key>` keys are accepted; their actual underlying/strike/expiry must have been verified externally against the current Upstox BOD JSON.
- V3 `MARKET_INFO` and NSE_FO status control: no quotes before an open market status or after reconnect until new status arrives. Unknown symbols, malformed/oversize frames, future LTT, invalid LTP and stale snapshots are dropped or denied; source `ltpc.ltt` milliseconds are preserved, never replaced with the receiver clock.
- TLS `wss://` one-use redirect validation restricted to Upstox-controlled domains and V3 feed path. A bounded **library-only** read-only `observe_one_use_session` can connect with a **freshly operator-authorized one-use URL**, send binary subscription, process Protobuf and submit accepted quotes to the separately permission-gated `PrivatePersistentIngest` WAL. No source executable is started by DigiOps.
- Explicitly refuses broker trading and public distribution. The persisted stream has the original account/tenant/entitlement scope, and WAL recovery provides monotonic de-duplication after restart.

## Provider facts confirmed in October 2026

- Official V3 market feed uses binary Protobuf (not the discontinued V2 JSON workflow): <https://upstox.com/developer/api-documentation/v3/get-market-data-feed/>.
- Provider `GET /feed/market-data-feed/authorize` needs a **per-account bearer session** and returns a **one-use** `authorized_redirect_uri`; do not cache or reuse it across retries: <https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3/>.
- `ltpc.ltt` is last-traded time; it may differ from `currentTs` or receiver time and does **not** independently prove the original exchange timestamp without an authorized comparative validation.
- Official instrument files recommend `instrument_key`, not ephemeral exchange tokens: <https://upstox.com/developer/api-documentation/instruments/>.
- Historical V3 candles use separately authorized V3 historical APIs, not live ticks: <https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/>.

## Important limitations, not yet implemented

- No Upstox login/OAuth interface or server-side bearer-token loader/API authorize HTTP action. The caller must securely acquire a **new one-use URL** from an already authorized account; no URL or token belongs in GitHub, CLI args, query logs or browser JS.
- No automatic reconnect: each future connection must reauthorize with a fresh redirect and re-check exchange display/persistence rights. Running the bounded Rust library function is **not** evidence that Cloudways supports persistent workers.
- No continuously managed app-level worker, no token refresh, no backoff supervisor, no TLS/secret deployment, no real Upstox API calls in tests, no live sample CE/PE packet captured.
- Upstox V3 feed subscription uses current provider-owned instrument IDs; this decoder cannot independently certify strike, expiry, corporate actions, licensure or redistributability from the ID alone.
- No new browser `/qsyn/terminal` live mode, no history import changes, no chart-grant activation, no PHP front-controller changes.
- Trading remains disabled and the homepage remains the existing staged simulation.

## Required operator acceptance

1. Verify two legitimate **currently listed** NIFTY/BANKNIFTY CE and PE instrument keys, matching expiry and strike from an independently obtained Upstox JSON master; record *sanitized* evidence only.
2. Confirm account-level market-data display and **separately** retention rights in writing for each account, scope and intended user; broker login by itself is insufficient.
3. Provision a private runtime with outbound TLS, owner-only file permissions, supervised worker, signing keys and restart recovery; never put provider bearer/one-use URL in public webroot or command line.
4. In an approved private environment, use a fresh authorized one-use URL, observe real binary V3 `MARKET_INFO`, CE/PE packets and distinct `ltpc.ltt`, `currentTs`, `received_ms`; check gap, stale, logout, reconnect, expiry, roll, retention and WAL restoration with two isolated accounts.
5. Only after separately audited PHP user-session→chart grant and TLS WSS proxy rights can a real React chart connect. Do not enable live trading.

**CI:** Rust tests use generated fake V3 Protobuf frames, scope failures, bad/future LTT, stale packets, restart WAL and wrong-account rejection. They do not authenticate against Upstox or assert market-data availability.

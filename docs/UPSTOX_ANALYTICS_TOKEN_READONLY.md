# QSYN — read-only Upstox Analytics Token (OAuth alternative)

## Scope and provider documentation

This is a **separate Analytics Token credential** for the operator's private
market-data engine, not a new trading/broker connection or public feed.
Official Upstox docs: https://upstox.com/developer/api-documentation/analytics-token/

The Analytics Token is read-only, generally valid for one year, and supports
the official market quote, historical candles, and market-feed WebSocket APIs.
Only one Analytics Token may be active per Upstox account; regenerating it
invalidates the earlier one. Upstox account-specific **User/Profile** APIs
may require a whitelisted static IP. For this reason QSYN **does not** use
the User/Profile endpoint to verify an Analytics Token.

A token is verified at import by one bounded HTTPS GET to the official
`/v3/feed/market-data-feed/authorize` endpoint. The authorized one-use
private WSS redirect must have the expected Upstox HTTPS-owned domain and
is immediately discarded without being returned to the browser. Success
proves that Upstox accepted market-feed authorization **at that instant**,
not the owning Upstox account, display/retention/redistribution entitlements,
process liveness, or an actual index tick.

## Cloudways operator prerequisites

1. Deploy a reviewed QSYN DigiOps artifact containing
   `NativeUpstoxAnalyticsApi.php` and matching Rust index-worker executable.
   Authenticate to QSYN Terminal > Brokers with the QSYN administrator.
2. Set `QSYN_RUNTIME_DIR` to an existing absolute private server directory
   outside any webroot (not world-writable). The importer creates or uses a
   child `upstox-private/` directory with owner-only 0700 permissions.
3. Set `QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID` to your expected Upstox
   user ID, *or* retain the existing owner-only
   `upstox-private/upstox-app.json` with the correct expected user ID.
   This is **operator-supplied binding, not provider account verification**.
   No app API key, app secret or OAuth callback is otherwise needed.
4. Set `QSYN_UPSTOX_ANALYTICS_IMPORT_ENABLED=1` with trading flags disabled.
   Restart only the relevant PHP application process if required.
   **Do not** set `QSYN_UPSTOX_INDEX_WORKER_ENABLE`, licensed display,
   retention or private chart flags unless separately authorized.
5. Generate an Analytics Token on the Upstox Developer Apps **Analytics**
   page. Copy it directly into the administrator-only **Analytics Token**
   field in QSYN Brokers over HTTPS. Never provide it in ChatGPT, GitHub,
   screenshots, a terminal command argument, a support log or browser console.
6. Click **Verify and store Analytics Token**. QSYN checks V3 feed
   authorization, writes an atomic 0600 private
   `upstox-analytics-session.json`, and clears the browser form field.
   `analytics/status` returns only a boolean, never the token.
   Existing `upstox-session.json` OAuth credentials remain untouched.

## Connecting the worker — explicit operator action

The private worker's `QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1` JSON plan has a
`private_oauth_session_file` field for historical naming compatibility.
When (and only when) independently authorized, point this field to the
private **upstox-analytics-session.json** path instead of the OAuth session
path. That file has a distinct strict schema
`QSYN-UPSTOX-ANALYTICS-SESSION/1`, recognized by the Rust index worker.
Every rotated V3 WebSocket session rechecks current private BOD mapping,
account binding, 0700 durable WAL directory, instrument allowlist,
nonexpired rights and the current token at the Upstox provider endpoint.

The existing operator commands remain:
`qsyn-upstox-index-worker check PLAN.json` (no feed activation)
and `qsyn-upstox-index-worker run PLAN.json` (operator approval only).
Licensed 1-minute historical index imports can use the same approved
plan and separate `qsyn-upstox-index-history` binary.

Provider identity should be independently verified by a supported
account-scoped method where permitted (including static-IP whitelisting
if necessary); merely supplying an expected user ID does not verify it.

**Important:** The importer does **not** generate private BOD mapping,
exchange display/retention rights, a Rust worker plan, a running worker,
WSS reverse proxy, stored index candles or a trading permission.

## Safe failure and rollback

- Invalid/revoked/expired token: no new session file on failed import;
  existing valid file remains unchanged.
- Missing admin session, forged Origin/CSRF, unsafe directories, wrong
  HTTP method or invalid content: fail closed.
- **Remove local token** deletes the private file only. To revoke the
  Upstox credential itself, use the **Revoke** action on Upstox Developer
  Apps; QSYN cannot revoke it through the local button.
- The public `/qsyn/api/v1/india/bars` stays unavailable to unlicensed
  viewers. Broker trading remains disabled.
- To roll back, disable `QSYN_UPSTOX_ANALYTICS_IMPORT_ENABLED`, stop the
  independently supervised worker (if any), and revoke the Upstox token
  through Upstox.

## Acceptance

- PHP HTTP tests: active administrator, no app-secret requirement, CSRF,
  cross-origin, unsafe storage, malformed token rejection and independent
  file selection.
- Rust test: strict separate Analytics session schema, no trading rights,
  no unknown fields.
- Human confirmation after deployment: Upstox feed-authorization status,
  current exact NSE/BSE BOD instrument keys, licensed account-scoped index
  data, WSS exchange timestamps and immutable historical OHLC.
- Distinguish *provider market authorization now* from *private index
  feed activated* and *live exchange data verified*. None follows
  automatically from successful token import.

## Verify stored token before operator activation

After an approved Cloudways deployment, open Terminal > Brokers and select
**Verify stored token**. The administrator-only
\`POST /qsyn/api/v1/admin/upstox/analytics/verify\` route re-reads the existing
0600 Analytics Token file, rechecks its strict schema and operator-configured
Upstox User ID, and makes a single fresh read-only HTTPS V3 feed-authorization
request. It requires same-origin, administrator session and CSRF; it never
accepts a token from the browser or returns any token or one-use WSS URL.

A passing result is \`UPSTOX_ANALYTICS_MARKET_AUTHORIZED_NOW\`. A rejected
token or temporary Upstox outage returns
\`UPSTOX_ANALYTICS_MARKET_AUTH_UNAVAILABLE\`. Missing/unsafe files fail
closed. These diagnostics do **not** attest the provider account identity,
independent NSE/BSE display/retention rights, current BOD mapping, running
index worker, exchange timestamps, or whether the public site can distribute
index prices. Do not enable worker or exchange permission flags on the basis
of a successful token check alone.

Cloudways operator then selects the separate Analytics session file in an
**independently approved** index worker plan and runs
\`qsyn-upstox-index-worker check /ABS/PRIVATE/PLAN.json\` to validate the
current file-based gates before any authorized process activation.

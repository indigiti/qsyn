# QSYN — Private chart session grant: PHP identity → Rust WSS

**Milestone:** read-only, source-level integration; no broker authentication or public live-feed activation. The same PHP/Rust and private file architecture remains. No Python service, database or public homepage cutover.

## Why this component

The existing Rust `qsyn-private-chart` executable already requires `QSYN-PRIVATE-CHART-ENTITLEMENT/1` evidence and short-lived HMAC tickets. No browser-facing authenticated token issuer existed, so a browser couldn't safely request its own account/instrument subscription. This change adds **only** a private development/test session issuer. It is not a replacement for Upstox OAuth, OpenAlgo's broker processes, licensed exchange access or a production authenticated tenancy service.

## Endpoint contract

`POST /qsyn/api/v1/terminal/private-chart-grant`

Exact JSON request:

```json
{"account_id":"operator-approved-account-alias","instrument":"NFO|CURRENT_ALLOWED_KEY"}
```

The route is disabled by default, returns 503 unless **both** `QSYN_PRIVATE_CHART_GRANTS_ENABLED=1` and the existing `IdentityApi::privateRoot()` development identity gate permit the caller, and additionally rejects any `QSYN_TRADING_ENABLED=1` or `QSYN_ENABLE_LIVE_TRADING=1`. The identity gate itself requires **test loopback** or an operator-confirmed private development HTTPS hostname and separate `QSYN_USER_SESSION` cookie; it is not available to the public QSYN application.

Successful requests require a logged-in, currently active `viewer` or higher, POST + same-origin `Origin`, CSRF token from the authenticated session, a strictly bounded body with no user/tenant authority fields, a currently positive entitlement, and a broker session that the **operator has independently verified**. The configured entitlement must match the session tenant and user ID, account alias, chosen instrument, broker `upstox` and license reference. Unknown contracts and expired rights fail closed.

Two **operator-created** owner-only private files must reside directly inside the already approved 0700 identity root, outside the webroot:

- `QSYN_PRIVATE_CHART_SIGNING_KEY_FILE`: raw 32-byte secret, mode 0600 (not printable hex text).
- `QSYN_PRIVATE_CHART_RIGHTS_FILE`: strict `QSYN-PRIVATE-CHART-ENTITLEMENT/1` JSON, mode 0600, matching exact authenticated scope and proof of legal *viewer-specific* rights, with `valid_until_ms` more than 30 seconds ahead.

**Never create a rights file from a user's requested symbol alone.** Its true `can_display_to_this_user` and `broker_session_verified` bits are assertions from trusted out-of-band verification; CI sets these values only in fake test fixtures. Provider OAuth alone does not grant public redistribution.

Response: `QSYN-PRIVATE-CHART-GRANT-RESPONSE/1` with one HMAC-signed, 30-second `qsyn-private-chart` audience ticket, `expires_ms`, account and instrument. It explicitly says trading disabled and public redistribution forbidden. `Cache-Control: private, no-store`. No broker token, API key, provider URL or owner/tenant ID is returned in a separate response field. Treat the ticket as sensitive; do not put it in a query string, persistent localStorage, analytics, logs or diagnostics.

The ticket is compatible with `ChartSigner::verify` in Rust: URL-safe base64(no pad) encoded JSON `ChartGrant` with exact field order plus HMAC-SHA256 signature, checked against the **current** Rust rights file on every tick/second. A PHP→Rust interoperability test signs a fake ticket and independently verifies the exact Rust HMAC implementation including expiry and revocation.

## Provider V3 architecture: not yet activated

Current official Upstox V3 workflow uses `GET /feed/market-data-feed/authorize` with an account access token, a one-use `authorized_redirect_uri`, and a **binary protobuf** WebSocket stream. The earlier V2 market feed is discontinued. Current V3 historical candles use `/v3/historical-candle` and `/v3/historical-candle/intraday` with authorized instruments and appropriate time windows.

Official docs:
- https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3/
- https://upstox.com/developer/api-documentation/v3/get-market-data-feed/
- https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
- https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/

**These V3 provider endpoints are not called in this release.** Existing private OpenAlgo observer remains operator-only, and no source worker or WSS proxy is installed here.

## Acceptance evidence and remaining launch gates

- PHP HTTP suite: token only to current authenticated owner with matching rights; reject outsider, wrong account/tenant, wrong instrument, wrong origin, missing CSRF, wrong file permissions, expired/revoked rights, unsupported fields and deactivated user.
- Rust/PHP integration: signature and exact claim structure accepted by Rust `ChartSigner::verify`, denied when expired, account switched or entitlement revoked.
- Existing Rust private chart WS tests: loopback scope enforcement, tick integrity and revocation continue passing.
- Release packages server-only PHP issuer, not credentials. Feature flags remain OFF.
- Operator **must** prove actual Upstox CE+PE listed expiry/instrument mapping, provider timestamps, rights/retention, continuously supervised source worker, WSS reverse-proxy session authentication, account-aware historical backfill, feed replay/continuity, revocation behavior, outage alerts and licensed public display before showing a real chart.
- No browser auto-WSS client or default real chart mode is enabled by this PR. Production identity is not the existing mock fixture system.

**Deployment boundary:** the presence of this route in a DigiOps artifact is not evidence that Cloudways or Upstox was connected. Keep `/qsyn/` and `/qsyn/terminal` simulated until private external acceptance is complete.

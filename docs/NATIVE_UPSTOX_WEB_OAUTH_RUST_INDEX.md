# QSYN — Native Upstox Web OAuth and Rust Index V3 (Phase A)

**The public chart-only homepage /qsyn/ is unchanged.** Native Upstox controls are behind the existing administrator password on /qsyn/terminal/brokers. OpenAlgo Python and OpenAlgo application API keys are not required for native Upstox.

## Operator web workflow

1. Sign in at /qsyn/terminal/login and open Brokers > Upstox.
2. Create an Upstox Developer App using your own authorized account. Its API Key is the client ID and its API Secret is the client secret. These are Upstox credentials, not OpenAlgo keys.
3. Register the exact callback shown by QSYN: https://stage.digiti.in/qsyn/api/v1/admin/upstox/callback. The application checks the trusted staging host; there is no browser-supplied arbitrary redirect.
4. Enter the developer API Key, API Secret and the expected Upstox User ID. QSYN compares that ID with the authenticated identity returned by Upstox. Save the private, one-time configuration.
5. Select Connect Upstox (OAuth), which redirects you to the official Upstox login. Your Upstox password and OTP stay on Upstox.
6. The callback validates a random, short-lived, one-time state and then exchanges the authorization code server-side at Upstox. The access token stays in an owner-only 0600 file; the browser is redirected to the admin terminal without the token.
7. On return, refresh the status: 'token stored' only confirms identity checked at exchange. It does not confirm token current validity, live exchange subscription, licensed index display or trading authorization.

## Private files and rotation

The PHP app uses QSYN_RUNTIME_DIR/upstox-private (or an approved QSYN_UPSTOX_PRIVATE_DIR inside the runtime), 0700 and matched to the PHP Unix owner. upstox-app.json, upstox-client-secret.key, upstox-oauth-pending.json and upstox-session.json use 0600. No new QSYN database. App setup is one-time only; it cannot silently overwrite or display secrets. A trusted operator must explicitly revoke and rotate an existing developer app.

An upstream callback has no Strict SameSite administrator cookie; its 256-bit state is the authorization check. A pending state expires after five minutes and is consumed before token exchange. Account mismatch fails closed. A callback outcome uses a sanitized redirect, never an echoed code or token.

Official Upstox documentation notes that API tokens expire around 03:30 IST the following day. No automatic refresh token is assumed. Reauthorize using the browser when necessary.

## Rust index preparation, not market activation

The Rust UpstoxIndexV3Plan and UpstoxV3IndexDecoder implement an isolated NSE_INDEX/BSE_INDEX current-BOD subscription plan, binary ltpc V3 subscription, index LTPC Protobuf decoding, provider market-open checks, current timestamps, de-duplication and account-scoped private quote candidates. They require separate validated session, current instrument mapping and explicit exchange display authorization; an OAuth token alone cannot activate data.

The next gate is a supervised Rust index worker using a fresh authorized Upstox V3 WebSocket URL, instrument-master mapping, approved licensed WAL, historical backfill and protected WSS fan-out to subscribed React index charts. The existing public India bars endpoint must remain blocked until authorized. Native trading and all order execution remain disabled.

## Acceptance and provider docs

CI: Administrator-only setup, CSRF and origin checks; 0600 secrets; one-use state and fake exchange callback; replay/mismatched identity; Rust index validation and Protobuf; React browser regressions; verified DigiOps artifact. CI never uses a real Upstox account.

- https://upstox.com/developer/api-documentation/authentication/
- https://upstox.com/developer/api-documentation/get-token/
- https://upstox.com/developer/api-documentation/v3/get-market-data-feed/

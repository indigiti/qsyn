# QSYN Terminal — Administrator-only access and native Upstox architecture

## Access boundary (web)

- The chart-only homepage at /qsyn/ (and legacy root /) intentionally remains public, unchanged.
- Every /qsyn/terminal workspace, including brokers, markets, strategies, diagnostics, operations and private-live, requires the existing **QSYN administrator password/session**, enforced by PHP **before** any React UI is rendered.
- Retired HTML aliases /qsyn/studio, /qsyn/admin/rust and /qsyn/legacy-chart are covered before their pretty-URL redirects. Direct /qsyn/terminal.php access is independently checked.
- Anonymous navigation receives a no-store 303 to /qsyn/terminal/login. The standalone login form uses an independent anonymous-session CSRF, validates same-origin HTTPS requests, and uses the existing password hash and lockout (five failures => 15 minutes).
- If the administrator password has never been created, the same login page offers one-time setup using the existing private 0600 Cloudways setup-code mechanism. No setup code is returned over HTTP.
- Login and private operations use the existing QSYN_ADMIN_SESSION Secure/HttpOnly/SameSite=Strict cookie and its 20-minute inactivity limit. Sign out calls the existing CSRF-protected admin logout.
- A browser session that expires is redirected back to /qsyn/terminal/login. An authenticated React page is *not* proof of live broker identity or exchange display rights. Market-data, history, chart-grant and order APIs must continue to enforce their own independent scopes.
- Existing nonprivate public market endpoints remain public independently of this UI gate. Public JS and CSS assets are not secret; users cannot infer permission to private feeds from their existence.

## Correct Upstox ingestion path

**Upstox OAuth (native QSYN backend, not yet web-activated)** → **Upstox Market Data Feed V3 (Protobuf WSS)** → **Rust ingestion / private WAL / index aggregation** → **authenticated, licensed Rust WSS fan-out** → **React OpenAlgo Charts widget**.

The Upstox card no longer presents or requires an **OpenAlgo application API key**, OpenAlgo Python installation, or OpenAlgo REST/WS port setup. The legacy OpenAlgo integration remains an optional, separate path for other broker experiments.

Current Rust source has a private V3 CE/PE observer, reconnecting worker, durable ingest and separate account-scoped private chart WSS components. These source modules do not prove that actual Upstox OAuth, exchange index keys, account-specific index V3 subscription, live index history, production Cloudways process supervision or a licensed chart stream have been activated. Do NOT show connected/live prices without those checks. The existing India bars endpoint correctly stays unavailable until verified.

The desired later phase is an administrator-only native Upstox OAuth web callback/consent implementation, followed by NSE_INDEX/BSE_INDEX current instrument-key subscriptions, Rust V3 index feed supervision, index-specific candle aggregation/history, and account-scoped chart grants. Keep all execution disabled.

## Acceptance

CI tests anonymous GETs, legacy aliases, non-GET rejection, malicious origin, invalid login CSRF, incorrect password, authenticated navigation, login/logout revocation, public homepage preservation, and first-time private administrator setup. Browser acceptance authenticates before loading terminal, exercises the original React workspace and checks there is no broker-data/order activation. DigiOps packages and validates all auth PHP modules, dedicated static CSP-safe login markup/style, and compiled chart bundle.

**Staging is not automatically deployed by a GitHub merge.** Deploy the exact green DigiOps artifact, then verify /qsyn/ still loads chart-only, /qsyn/terminal/brokers redirects to login anonymously, and after admin sign-in opens the native Upstox readiness screen. Check logout and idle-session revocation. Never place the QSYN admin password or a real Upstox secret into GitHub or a support ticket.

# QSYN Cloudflare JSD / CSP compatibility audit — 2026-10-12

## Evidence

The operator's Chrome DevTools screenshot of `/qsyn/` shows an unexpected inline `<script>` at document line 16 immediately after QSYN's external terminal bundle. The script initializes `window.__cf$cv$params`, consistent with Cloudflare's challenge platform. The browser blocks it under QSYN's original `script-src 'self'` policy.

Cloudflare documents that its JavaScript Detections (JSD) script can cause that specific CSP error when a site omits a CSP nonce. Cloudflare parses a response-header `script-src 'nonce-...'` and attaches the nonce to scripts that it injects. Disabling injection by `Cache-Control: no-transform` is an alternative but causes the `cf.bot_management.js_detection.passed` signal to be missing on affected pages.

Authoritative documentation: https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/

## Selected implementation: CSP nonces on charts/terminal (preserves JSD)

The revised patch now creates an independent cryptographically generated nonce using `base64_encode(random_bytes(18))` **for each rendered HTML response** on:

- The canonical QSYN chart homepage and authenticated terminal workspaces, including Brokers.
- The direct physical `terminal.php` shell fallback (defense in depth).
- The optional development mock account dashboard.

The page's CSP uses `script-src 'self' 'nonce-{value}'` and the existing local script tags are bound to the matching nonce. `Cache-Control: no-store` remains; these pages do **not** send `no-transform`, so Cloudflare JSD remains eligible to run and populate its bot signal. Do not use `unsafe-inline`, hard-coded script hashes, `unsafe-eval` or third-party script source exceptions.

The administrator sign-in/setup template intentionally uses no application JavaScript, `default-src 'none'`, and `Cache-Control: private, no-store, no-transform`. Keeping this specific form unmodified prevents scripts being injected into a password collection page. Its absence of JSD signal must be reviewed against any Cloudflare custom rule targeting direct login requests; a nonce-enabled sign-in flow is a separate, security-reviewed option if policy demands it.

JSON API endpoints, historical market data endpoints, Upstox OAuth, Rust streaming, user sessions, order/risk gates and exchange license enforcement are unchanged.

## CI/regression coverage

- PHP HTTP smoke: homepage and authenticated terminal enforce CSP nonces and matching script attributes; a second homepage response produces a different nonce. Login retains no scripts and `no-transform`.
- Chromium smoke: homepage and directly reloaded Brokers view provide matching CSP nonces; first-party templates still contain no inline script; Cloudflare JS Detection remains eligible on chart and terminal routes.
- Release packaging/verification and Rust tests must pass.

These CI tests inspect origin-generated HTML. They **cannot** prove Cloudflare actually decorates the injected script correctly on stage. That remains an edge/browser acceptance test.

## Cloudflare/security verification

1. Review Cloudflare custom WAF rules involving `cf.bot_management.js_detection.passed` or Workers expressions `request.cf.botManagement.jsDetection.passed`. Keep bot challenges/rate limits/network ACLs active.
2. Deploy the exact green, merged `main` DigiOps artifact to Cloudways. A PR artifact is not proof of deployment.
3. Inspect `/qsyn/` and `/qsyn/terminal/brokers` document **response headers**: `Cache-Control` contains `no-store` (not `no-transform`), `Content-Security-Policy` includes a unique nonce, and the first-party script has that nonce.
4. Inspect the edge-generated `window.__cf$cv$params` inline script in Chrome DevTools, if present, and verify it is decorated with the nonce and no longer triggers a CSP violation. Verify the chart paints and broker discovery remains read-only.
5. Inspect `/qsyn/terminal/login`: existing CSP remains `default-src 'none'`, `no-transform` is present and password/CSRF protections continue to operate.
6. If Cloudflare fails to annotate its script, check actual response headers, competing CSP headers, cache/proxy transforms and Cloudflare security configuration before changing the CSP. Do not add `unsafe-inline`.
7. Confirm no changes to the six index-discovery entitlement/activation flags or live OMS/trading settings.

This change fixes the documented origin/edge CSP compatibility mechanism but does not certify account-level Cloudflare WAF rules, actual Cloudways deployment, or live JSD execution.

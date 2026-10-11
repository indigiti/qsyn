# QSYN terminal session and native Upstox diagnostic audit

Scope: existing QSYN admin terminal, PHP password session, Upstox profile check and secure diagnostic center. Public chart-only homepage and trading=disabled are unchanged.

## Reproduced code defects / corrections

1. Wrong password redirects on temporary upstream failures: previously, terminal.jsx forced location.replace('/qsyn/terminal/login') whenever the sixty-second admin-state request had HTTP 503, bad JSON or a network failure. The client now redirects only for a confirmed 401 or authenticated=false, and shows a warning for temporary server errors. Protected APIs remain independently gated.
2. Session expiry: PHP admin session idle was twenty minutes and PHP's default GC could prune session storage. New idle limit is one hour, with an eight-hour absolute cap and matching PHP GC. Session cookie still uses Secure, HttpOnly, SameSite=Strict and Path=/qsyn/ and is not made persistent across browser closure. Logout and expiry continue to require new password authentication.
3. Opaque Upstox failure: live profile verification now returns enumerated codes for missing/unreadable token, account mismatch, upstream 401/403 token expiry, provider downtime, invalid response and verified active account. Results never contain provider identity, bearer tokens or raw API errors.
4. Administrator diagnostics: authenticated GET /qsyn/api/v1/admin/diagnostics/report provides schema QSYN-ADMIN-DIAGNOSTICS/1, request ID, timestamp, secure session state, private app/token-file presence, packaged Rust worker check and explicit "not verified" for Upstox licensing and the live feed. The endpoint never calls Upstox or starts a process.
5. Frontend error JSON: Upstox verify/setup/begin now gives client progress, a bounded 15-second timeout, HTTP status, request ID, enum code, elapsed milliseconds, and Copy safe JSON. It never includes OAuth URLs, token, CSRF, passwords or private paths. Diagnostics workspace offers Run secure audit and Copy diagnostic JSON.
6. Misleading broker status: the Upstox selector previously declared OAuth inactive even when a token was stored and verified. It now distinguishes OAuth from the inactive index feed. The Refresh broker status button now reloads native Upstox state when Upstox is selected instead of refreshing only the unrelated public broker catalog.
7. Browser regression tests check that a valid session remains on the terminal when an admin-state request receives an injected HTTP 503, and that the protected diagnostics endpoint is available to the logged-in administrator.

## Testing staged deployment

Use HTTPS stage.digiti.in and one browser profile. Login once with the existing QSYN admin password. In Brokers > Upstox, click Verify current Upstox session, then Copy safe JSON to capture the outcome. In Diagnostics, use Run secure audit and Copy diagnostic JSON.

Never paste the full Network tab, cookies, authorization headers, Upstox API secrets, or account IDs into a support conversation. Redacted generated reports are sufficient.

A browser restart still loses a session-only cookie by design; an explicit logout and the eight-hour absolute cap also require login. Any forced login following a transient 5xx is a regression.

Current provider session verification is point-in-time only; neither an Upstox token nor a packaged Rust worker proves a live licensed NSE/BSE index feed. Live trading remains disabled.

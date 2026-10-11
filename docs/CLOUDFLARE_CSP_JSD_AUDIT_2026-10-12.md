# QSYN Cloudflare JavaScript Detection / CSP integration audit

## Observed staging evidence (2026-10-12)

The operator's Chrome DevTools capture of `/qsyn/` shows an additional `<script>` at document line 16, immediately following QSYN's external terminal bundle. The script contains `window.__cf$cv$params`, an iframe-based Cloudflare JavaScript Detection challenge signature. The browser blocks that script because QSYN deliberately sets `script-src 'self'`. This is **not** emitted by the terminal.php template. Other reports (workspace 503, chart AbortError, or Apache wafcl broken pipe) are independent issues.

Cloudflare's JavaScript Detections documentation states that `Cache-Control: no-transform` on the HTML response suppresses injection, and that Cloudflare's JSD signal will be missing for those requests. It also documents a CSP-nonce integration alternative.

Reference: https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/

## Scope of change

- Apply `Cache-Control: no-store, no-transform` **only on rendered terminal HTML** via the canonical PHP router and the direct `terminal.php` shell.
- Apply `private, no-store, no-transform` on the optional mock account dashboard HTML and restricted password/setup form HTML.
- Leave JSON endpoints, market history, Upstox OAuth and Rust runtime endpoints unchanged.
- Preserve the strict `script-src 'self'` and login `default-src 'none'` security policies. Never allowlist a rotating Cloudflare inline script hash or use `script-src 'unsafe-inline'`.
- Assert protected and public HTML transport headers and the absence of first-party inline scripts in existing PHP/Playwright tests.

## Security tradeoff / operator decisions

The purpose of `no-transform` is to keep the delivered HTML intact. **Cloudflare JavaScript Detections will not operate on these pages**, which can affect bot scoring or WAF rules relying on `cf.bot_management.js_detection.passed`. Before production rollout, the Cloudflare/WAF administrator must review whether an explicit JSD rule is relied on for the main chart, admin login or terminal, and retain rate limiting, managed challenges and access controls. Admin login must remain protected by its existing PHP sessions, CSRF, lockouts and preferably network controls.

If Cloudflare policy requires JSD, do not remove `no-transform` casually: a carefully reviewed, cryptographic nonce-based CSP/Cloudflare integration is the alternative and must be browser-tested on every protected route.

## Deployment validation

1. Merge only after green PHP/React/Chromium CI and DigiOps artifact validation for the exact source SHA.
2. Deploy the matching artifact to Cloudways; GitHub packaging alone does not update staging.
3. In Chrome DevTools > Network > Doc > `/qsyn/`, verify the **actual** response header contains `Cache-Control: no-store, no-transform` and the document response does **not** include `window.__cf$cv$params`.
4. Verify `Content-Security-Policy` retains `script-src 'self'`; the external terminal bundle renders and no new inline-script CSP violation appears.
5. Repeat on `/qsyn/terminal/brokers` after administrator login and on `/qsyn/terminal/login`; keep the login CSP restricted and verify session/CSRF isolation.
6. If injected HTML persists despite `no-transform`, use Cloudflare Trace / Security Events and Cloudways origin-versus-edge response comparison. Cloudflare challenge pages, another edge transformation or browser extension may need separate vendor-side remediation.

No broker feed, public redistribution or trading authorization is enabled.

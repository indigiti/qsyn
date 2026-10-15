# Optional no-login NSE/BSE owner viewer

The homepage at `/qsyn/` is already unauthenticated and read-only. This change separates its **owner-only** NSE/BSE chart authorization from the terminal administrator login; it does **not** create a publicly redistributable Upstox index feed.

## Single-owner QSYN: one-click browser authorization (recommended)

With a successful deployment and an existing writable QSYN **private** runtime,
the owner does **not** need to configure a static IP, a pinned hostname, a
separate service, or PHP environment variables just to authorize the chart.

1. Sign in to the existing password-protected Terminal and open
   `/qsyn/terminal/diagnostics`.
2. Click **Enable personal index charts in this browser**. A same-origin,
   admin-session + CSRF-protected POST first creates a random 32-byte
   `owner-index-grant.key` in the existing private runtime, mode `0600`
   and owned by PHP. It does **not** modify the Upstox session or enable orders.
3. QSYN issues an HttpOnly, host-only, Secure, SameSite=Strict signed cookie
   under `/qsyn/` for seven days and checks that the browser actually
   received authorization. Then open `/qsyn/` and select the index.
4. A second browser must be explicitly authorized. Changing public IP does not
   invalidate the first authorized browser. Repeating the action renews
   authorization but never replaces an existing signing key.

Prerequisites: the existing QSYN runtime directory must be canonical,
non-public, non-symlinked, not world-writable, writable by PHP and accessible
through `QSYN_RUNTIME_DIR` or the application's private default runtime.
When it cannot be safely written, the authorization action fails closed with
`OWNER_PRIVATE_RUNTIME_NOT_WRITABLE`; do not write keys to `public_html`.

The following **explicit disables always win**:
`QSYN_PERSONAL_INDEX_OWNER_VIEWER=0`, `QSYN_PERSONAL_INDEX_ENABLED=0`,
`QSYN_PERSONAL_INDEX_OWNER_AUTH=legacy_ip`, trading enabled, or
an unavailable HTTPS/same-origin administrator session. No automatic public
feed, unlocked OMS route, new Rust worker, or independent licensed display
right is created. Existing fixed-IP environments still function unless the
administrator opts into browser-grant mode.

Advanced Cloudways provisioning remains an option: configure
`QSYN_PERSONAL_INDEX_OWNER_AUTH=browser_grant`,
`QSYN_PERSONAL_INDEX_OWNER_VIEWER=1` and manually create the same private
32-byte signing key if you cannot allow PHP to write the private runtime.
The admin password and all broker credentials stay server-side.

## Configuration

All three values must be configured by the operator on the private Cloudways application runtime:

- `QSYN_PERSONAL_INDEX_OWNER_VIEWER=1`
- `QSYN_PERSONAL_INDEX_OWNER_IP=<owner's fixed public IPv4 or IPv6 address>`
- `QSYN_PERSONAL_INDEX_OWNER_HOST=stage.digiti.in`

Default: disabled. Ensure the **trusted web-server `REMOTE_ADDR` is the verified actual owner IP**. On Cloudways/reverse-proxy infrastructure, independently verify the trusted-proxy client-IP configuration at the web server **and restrict these routes at the edge**; never take `X-Forwarded-For` straight from an untrusted client. If the IP is not reliably authenticated, leave disabled. A changing/dynamic IP requires a different authenticated private network solution (VPN/Zero Trust), not a blanket guest allow rule.

Data APIs: `GET /qsyn/api/v1/owner-index/status`, `POST /qsyn/api/v1/owner-index/history`, `POST /qsyn/api/v1/owner-index/ticket`. The last two require `X-QSYN-View-Only: 1`, same-origin HTTPS, fixed index aliases and read-only market data. Existing Rust-signed 35-second, symbol-scoped WebSocket tickets and 1m-history worker are reused. No new Rust binaries, DB, provider logins or OMS paths.

The homepage selects this mode only when an owner-only status check succeeds. Otherwise it preserves the administrator-scoped fallback; guests see 'Index source unavailable', not a login redirect. Index aliases offered: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, INDIA VIX, SENSEX and BANKEX.

**Do not enable** if your Upstox agreement or exchange entitlements do not permit this owner-private display. Setting `trading_enabled=false` is not evidence of data display or redistribution rights. This mode must not be enabled for an unrestricted/public website, and must not rely on a shared reverse-proxy IP.

## Acceptance

1. Confirm an anonymous request from outside the owner's permitted IP receives HTTP 403 for all three endpoints; do not leak candles or signed tickets.
2. From the allowlisted IP, `status` returns seven symbols and explicit `trading_enabled:false`. Only then test chart history and live timestamps with the actual deployed Rust service and a valid private Analytics Token.
3. Confirm that `/qsyn/terminal/*`, Upstox administrator APIs, order routes and Rust admin actions still require their existing authorization.
4. Confirm unauthenticated homepage remains chart-only. Never substitute simulated candles for absent NSE/BSE data or claim continuous 1s live data before observing real exchange timestamps.

## Troubleshooting: homepage says "Index source unavailable"

This label means the index chart did not obtain either an allowlisted owner-viewer
status or the separate administrator proof. **The homepage itself is public;
its index market-data feed is not.** A successful DigiOps application
deployment does not install an Upstox Analytics Token, start the private Rust
reader, or enable the owner-viewer gate.

From the intended **owner browser**, open
`https://stage.digiti.in/qsyn/api/v1/owner-index/status`:

| Result | Meaning and next check |
| --- | --- |
| `403 owner_viewer_unavailable` | Owner-only viewer is disabled or request did not match the exact, verified owner IP, pinned host, HTTPS or read-only flags. Review the three private Cloudways settings above and the trusted proxy/edge policy. Do not allow all visitors or blindly trust `X-Forwarded-For`. |
| `503 owner_index_unavailable` | Required PHP module missing from the deployed private DigiOps artifact; verify release files. |
| `200 QSYN-PERSONAL-INDEX-OWNER-VIEWER/1` | Owner-gate passed; **not** proof of market-data availability. The next checks are the independently provisioned Upstox private Analytics Token, permitted exchange rights, Rust personal-history reader and HTTPS/WSS ingress. |
| `404`, HTML, redirect, or unexpected body | Check release SHA, `/qsyn/` rewrite rules and Cloudways reverse-proxy routing before investigating broker data. |

After a 200 status, Chrome DevTools → Network shows two separate
`POST` endpoints: `/qsyn/api/v1/owner-index/history` (real 1m candles)
and `/qsyn/api/v1/owner-index/ticket` (short-lived Rust WSS authorization).
Both requests send `X-QSYN-View-Only: 1` in the current frontend.
A `409 upstox_analytics_token_not_ready` means the private token is absent or
failed validation. A `502 rust_personal_history_invalid_or_unavailable`
means the Rust history process did not return a valid licensed response.
A successful ticket response alone is **not** proof of a running WebSocket
or received exchange ticks; verify WSS and provider timestamps separately.

The real visitor's `REMOTE_ADDR` as seen by the trusted web server must
match the owner IP. On a shared Cloudways reverse proxy it might instead be
a proxy IP; never whitelist the proxy's IP as the owner. When a stable
verified client IP cannot be obtained, use an authenticated private network
(VPN/Zero Trust) or keep the owner-only viewer disabled.

Only display NSE/BSE index candles if your broker/exchange grants the specific
private display rights. Never replace missing feed data with fabricated prices,
borrow an unrelated user's token or expose an unrestricted public API.

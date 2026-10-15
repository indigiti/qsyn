# Optional no-login NSE/BSE owner viewer

The homepage at `/qsyn/` is already unauthenticated and read-only. This change separates its **owner-only** NSE/BSE chart authorization from the terminal administrator login; it does **not** create a publicly redistributable Upstox index feed.

## Alternative: authorize the owner browser without a fixed IP

Opt-in browser grant mode removes the static owner IP and owner hostname
configuration for the **data-viewing** path. It does **not** publish exchange
data or authorize any trading action. Keep HTTPS and licensed display rights.

1. Provision a fresh random, **exactly 32-byte** key outside public_html at
   \`$QSYN_RUNTIME_DIR/owner-index-grant.key\`, owned by the serving PHP user,
   file mode \`0600\`. Set \`QSYN_RUNTIME_DIR\` to its existing canonical private
   directory. Never commit, print, or expose the key.
2. Set \`QSYN_PERSONAL_INDEX_OWNER_VIEWER=1\`,
   \`QSYN_PERSONAL_INDEX_ENABLED=1\` and
   \`QSYN_PERSONAL_INDEX_OWNER_AUTH=browser_grant\`. Leave both trading flags off.
   The legacy IP and host settings are ignored **only in this mode**.
3. Sign in to the protected QSYN terminal, open
   \`/qsyn/terminal/diagnostics\`, and select
   **Authorize this browser for index charts**. This verifies the administrator
   session and CSRF and sets an HttpOnly, Secure, SameSite=Strict,
   host-only, seven-day read-only cookie scoped to \`/qsyn/\`.
4. Open the homepage on **the same browser and site**. The signed cookie
   survives changes of public IP. Other browsers receive 403 until authorized
   individually. Renew before expiry using the Diagnostics action.

Test failures: a missing, expired, tampered or wrongly signed cookie, a missing
key, inactive owner viewer, HTTP outside loopback tests, and trading-enabled
mode must all deny \`/owner-index/status\`, history, and ticket issuance.
Changing or deleting the server signing key immediately invalidates previously
authorized browsers. The administrator, OMS, Upstox OAuth, Rust service and
exchange entitlement restrictions remain unchanged.

**Operational caveat:** This mode protects chart access via a browser-held
authorization; it must only be used for data you are entitled to display in
this manner. Do not share or publicly redistribute licensed NSE/BSE data.
The key must be provisioned on Cloudways separately from deployment.

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

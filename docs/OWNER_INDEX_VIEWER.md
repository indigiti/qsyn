# Optional no-login NSE/BSE owner viewer

The homepage at `/qsyn/` is already unauthenticated and read-only. This change separates its **owner-only** NSE/BSE chart authorization from the terminal administrator login; it does **not** create a publicly redistributable Upstox index feed.

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

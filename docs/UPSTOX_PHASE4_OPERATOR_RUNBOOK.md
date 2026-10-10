# QSYN Phase 4: Upstox OAuth, supervised V3 ingestion, private charts and OMS gates

**2026-10-11 — Code implementation; NOT production activation.** Preserve PHP + Rust + private JSON and WAL files. No database or Python service. No secret, live exchange packet, broker session, Cloudways supervisor, or order has been accessed by these GitHub changes.

## What was built

| Component | Implementation | Remaining external acceptance |
|---|---|---|
| Upstox OAuth authorization code | `apps/web-php/src/UpstoxOperatorOAuth.php` + CLI `tools/upstox-oauth.php` | Real account consent + registered redirect + HTTPS and verified UCC |
| Native V3 feed supervisor loop | `services/stream-rust/src/upstox_worker.rs` + standalone `qsyn-upstox-worker` binary | Approved process manager, private account token, feed rights, real CE+PE verification |
| Account scoped WAL recovery | Existing `PrivatePersistentIngest` + V3 source | Replay test with real post-restart feed and legally approved persistence |
| Authorized chart WSS delivery | Existing `qsyn-private-chart` Unix datagram gateway + V3 WAL-after-write socket publishing + `frontend/src/private-live-chart.js` | Trusted TLS proxy with authenticated private origin, real Upstox ticks + browser UX acceptance |
| Production OMS | `oms_live_gate.rs` preflight + existing paper OMS/order reconciliation journal | NOT ACTIVATED. Broker order adapter, regulatory approvals, risk and reconciliation must be signed off |

## Operator-only OAuth — manual code exchange (no site token upload)

1. Obtain approved Upstox registered app/client ID, app secret and *exact matching* HTTPS redirect URI controlled by the QSYN operator. Your browser login goes directly to Upstox. Do not copy any secrets or authorization code into GitHub, chat, DigiOps, webroot or public URL logs.
2. Approve an absolute **0700** private directory owned by a dedicated PHP/Rust service user, outside `public_html`. Place `upstox-client-secret.key` in it with **0600** and verify that the PHP CLI `curl` extension and trusted TLS certificates are available.
3. Configure `QSYN_UPSTOX_PRIVATE_DIR`, `QSYN_UPSTOX_CLIENT_ID`, `QSYN_UPSTOX_REDIRECT_URI`, `QSYN_UPSTOX_EXPECTED_USER_ID` (your verified Upstox UCC/user_id). Do not store the API secret in an environment variable or GitHub.
4. Under the operator account, run `php apps/web-php/tools/upstox-oauth.php begin`. Visit the output authorization URL and complete Upstox consent.
5. Capture the returned **state and one-use code** directly through a protected operator process, not a browser-visible public dashboard or a logged generic callback. Pass JSON `{"state":"...","code":"..."}` on CLI stdin to `php apps/web-php/tools/upstox-oauth.php finish`. The endpoint `https://api.upstox.com/v2/login/authorization/token` is called *server-to-server*, TLS validated, redirection off. The one-use state is consumed before exchange; provider `user_id` must equal the operator's expected account ID. On success the bearer token resides only in the owner-only `upstox-session.json` private file with trading and entitlement flags **false**.
6. Run `php apps/web-php/tools/upstox-oauth.php status`: outputs **non-sensitive flags only**. Actual live Upstox success requires step 5 with a genuine registered app and human consent; CI tests use only fake transport responses.

A 401/403 from the provider requires a new authorization-code login and exact new one-use WSS URL. No undocumented refresh token is assumed. Do not install this CLI as an HTTP route.

## Continuous Rust feed worker — gated deployment

The worker requires a separate private JSON configuration `QSYN-UPSTOX-V3-PRIVATE-WORKER/1` (schema defined in `upstox_worker.rs`) owned 0600 by the service user. It references private **absolute** paths to:

- OAuth `upstox-session.json` produced by the real login.
- Current `QSYN-PRIVATE-CHART-ENTITLEMENT/1` rights file with BOTH CE/PE `NSE_FO|number` keys, current scope, owner, licensed display rights and valid broker session.
- Private preexisting owner-only **0700** market WAL root and `qsyn-private-chart` Unix datagram socket under another 0700 private runtime directory.

The worker configuration also requires independently documented `operator_approved_display`, `operator_approved_retention`, `current_bod_mapping_verified`, valid expiry, separate account/user IDs and finite reconnect attempts. **These values must come from real checks**, not a user-editable browser control or CI test fixture.

Commands (private operator, never public web service):

```sh
qsyn-upstox-worker check /absolute/private/worker-plan.json
# ONLY when checks pass, service supervisor approved and feed contract verified:
QSYN_UPSTOX_WORKER_ENABLE=1 QSYN_TRADING_ENABLED=0 \
  qsyn-upstox-worker run /absolute/private/worker-plan.json
```

At each bounded 120-second observation window, it rechecks private rights, account token and scope, gets a **fresh** V3 authorized redirect via TLS from `https://api.upstox.com/v3/feed/market-data-feed/authorize`, opens the one-use WSS, subscribes by **binary** message, decodes V3 Protobuf and verifies source `ltpc.ltt`. Authorized data is fsynced to account-scoped WAL before being passed to private Unix-socket chart fanout; stopped/revoked rights fail closed. Backoff is bounded; process exits after a configured maximum number of attempts. It is not installed as a Cloudways Supervisor program by the GitHub release.

Source feed and chart processes **must** have separate Cloudways-approved process supervision, privileged private directories, access to private authorized sockets and a correct HTTPS/WSS reverse proxy to `/qsyn/private-chart/ws`. Rust gateway listens only on loopback, verifies short-lived session ticket and rights each second, and is NOT publicly accessible by default.

## React live subscriptions

Visit `/qsyn/terminal?view=private-live` for a separate read-only private interface. Without an authenticated **private development** identity the page is locked. Under a private test session, the user enters an operator-approved account alias and CE/PE NSE_FO instrument keys, and the PHP private chart grant endpoint validates both rights and CSRF. The browser receives *only a 30-second ticket* and sends it in the first WSS authentication frame. It never receives the Upstox bearer token.

Each chart only accepts messages with the correct private source schema, account, instrument, increasing timestamps and fresh licensed quotes. It does not borrow demo OHLC history or open anonymous data feeds. Historical bars remain empty until an authorized account-scoped history endpoint is approved and integrated. Do not claim chart parity or that a live stream is working until a real private browser acceptance test validates canvas, quote continuity, gaps and reconnect after token expiry.

## Production OMS activation — NOT APPROVED

`oms_live_gate.rs` introduces strict code-level preflight for owner/account isolation, stale price, max notional, available margin, position quantity, lot size, daily-loss limits, market/exchange/algorithm approvals, observed broker reconciliation and kill switch. The reviewed decision explicitly states `broker_submit_enabled:false`. `submit_live_order_disabled` always rejects. Paper OMS and broker-order lifecycle journals remain for offline simulation and reconciliation preparation.

**Never** flip `QSYN_TRADING_ENABLED` or `QSYN_ENABLE_LIVE_TRADING` to 1 from DigiOps for this release. Upstox V3 place-order API requires additional live-account broker certification, permissions, order retries/idempotency, broker-side order reconciliation, regulatory checks, position/fund evidence, explicit risk limits and a user-controlled kill switch. OAuth and market-feed success are **not** equivalent to permission to place orders.

## Acceptance gates remaining

1. Cloudways/operator gives written approval for supervised private processes, loopback Rust WSS proxy and HTTPS origin. Verify restart/crash recovery with an actual process supervisor.
2. Actual Upstox OAuth flow completed with private token and verified UCC; no credentials surfaced in responses or logs.
3. Live **CE + PE** contracts verified from current Upstox BOD including underlying, strike, expiry, right to display and right to retain, and true provider timestamps.
4. Licensed V3 feed verification with continuous source observation, WAL audit, restart, backoff and account revocation. Assert no gap or stale quote labeled "live".
5. Licensed historical leg candles imported only with verified account scope and retention rights, then explicitly served to authenticated charts.
6. Actual user private chart WSS + browser test passing on HTTPS with valid grant and rights expiry handling, no anonymous feeds.
7. Before any live OMS, independently review exchange approvals, controlled execution adapter, client consent, trading hours, risk limits, order/fill/cancel consistency and rollback.

**Source passing CI is not production broker activation.**

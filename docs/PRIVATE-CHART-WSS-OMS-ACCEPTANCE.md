# QSYN private chart WSS + crash-safe collector + OMS reconciliation (2026-10-10)

**Release scope:** Source implementation only. Preserves the original upstream OpenAlgo application and **makes no changes to QSYN frontend/chart JavaScript, CSS or public PHP routes**.

**Operator baseline:** reported QSYN #144, commit `f2ec1663caf81ea7bae9233b46146af354847438`. This release adds a private, operator-gated WS transport, WAL recovery fix, durable order lifecycle, template Cloudways supervision and fake provider tests. A merge/CI/package verifies code, **not** a live broker, exchange consent or Cloudways operational installation.

## Code and security contracts

| Component | New behavior | Remaining prerequisite |
|---|---|---|
| Broker owner authentication | Uses existing private per-account OpenAlgo registry, with independent REST/WS loopback ports and app API keys. The actual upstream OpenAlgo app continues owning Upstox broker OAuth/TOTP/token renewal. | Real operator provisioned instances, customer consent, broker session, 2 independent Upstox users and actual exchange instrument subscriptions |
| Rust WAL recovery | On reopen with exclusive writer lock, scan and validate all previous WAL events; rehydrate latest provider timestamp per approved instrument. Deny mixed account, entitlement or data mode in a private WAL directory. No duplicate WAL events on reconnect/restart. | Backup/restore, retention approval, real market calendar/gap reconciliation and high-volume soak testing |
| Private chart event IPC | Collector fsyncs authorized quote first, then can send safe field values to a local owner-only 0600 Unix datagram socket. Re-check private retention approval approximately every 1 second during ticks. | Actual approved data rights; supervised worker; separate operator-only socket directory 0700 |
| Account-scoped chart WS | New `qsyn-private-chart` binds **127.0.0.1** only; validates 60-second HMAC grant tied to account, tenant, owner, broker, instrument and current private 0600 display rights file. Checks attestation again every second/on every tick. No source or browser secrets are embedded in the frontend. Revocation closes existing sessions. | Audited PHP user session-to-grant issuance and TLS/WSS reverse-proxy authentication. No public route implemented |
| Order lifecycle | Immutable hash-chained/fsynced, single-writer private order event journal. Rejects impossible transitions, cross-account events, filled quantity errors, broker-order-ID mutation and invalid cancellation/fill sequence. Verifies/replays journal on restart. | Trusted real broker order adapter and server risk receipt, orderbook/tradebook reconciliation, sandbox certification, explicit live trading approval |
| Cloudways | Owner-only, non-autostart sample Supervisor configuration for one broker worker and chart WS process. Includes log rotation, restart policy and process owner placeholders. | Cloudways operator must approve and install a real service manager; DigiOps packaging never starts the service |

## Upstox exchange timestamp validation — required operational acceptance

There are **two distinct timestamps**: exchange trade time and feed/receiver time. Upstox Market Data Feed **V3** is an official *protobuf/binary* WebSocket API (see <https://upstox.com/developer/api-documentation/v3/get-market-data-feed/>); its LTPC message includes `ltpc.ltt` (last traded time). OpenAlgo provides a *normalized JSON* loopback WebSocket with `data.timestamp`. These cannot be assumed identical or exchange-attested without comparing both in an operator-authorized account.

Operator must record sanitized evidence for NIFTY CE and PE on the same **currently listed expiry**: account IDs (non-secret aliases), provider instrument keys verified against current Upstox BOD, mapped OpenAlgo symbol/exchange, `ltpc.ltt`, normalized `data.timestamp`, monotonic receiver time, broker and exchange session market status, quote freshness and matching strike/expiry. Verify identical account scope, time units, plausible exchange lag, nonstale sequencing and gaps across reconnect. Test with separate Upstox A and B accounts. Do not send raw access tokens, phone numbers, private OAuth redirects or instrument files to GitHub.

**CI exercises synthetic provider data only; it cannot independently perform that real live verification.**

## Approved private operator installation

Prerequisites: manually verified permissions for display/persistence from broker/exchange; independently authenticated OpenAlgo apps on localhost, user-owner legal right attestation, Unix UID ownership, Cloudways isolated private app and Supervisor permission. Root directories should be absolute, canonical, owner-only and outside webroot. Do not create permissions by setting a true boolean unless provider terms actually allow it.

Two separate 0600 files are required for charting, placed outside webroot and created by the approved operator:

- `QSYN_PRIVATE_CHART_SIGNING_KEY_FILE`: 32 bytes of CSPRNG output, e.g. `umask 077; openssl rand 32 > /ABSOLUTE/PRIVATE/chart-signing.key`. Do not check the key into GitHub or expose it to the client.
- `QSYN_PRIVATE_CHART_RIGHTS_FILE`: 0600 JSON representing externally verified, currently valid account-owner display rights.

Example *schema*, not a real permission certificate:

```json
{
  "schema":"QSYN-PRIVATE-CHART-ENTITLEMENT/1",
  "tenant":"APPROVED_TENANT",
  "account":"APPROVED_UPSTOX_ACCOUNT",
  "owner":"APPROVED_OWNER",
  "broker":"upstox",
  "instruments":["NFO|CURRENT_LISTED_CE","NFO|CURRENT_LISTED_PE"],
  "license_id":"APPROVED_DISPLAY_LICENSE",
  "can_display_to_this_user":true,
  "broker_session_verified":true,
  "valid_until_ms":1800000000000
}
```

**Do not reuse that expiry number for a real session.** For multiple users/accounts use independently authorized rights files, independent worker/WSS and Unix socket isolation, and ideally separate process UIDs. The chart gateway runs only when the operator opts in:

```sh
export QSYN_PRIVATE_CHART_GATEWAY_ENABLED=1
export QSYN_PRIVATE_CHART_RIGHTS_FILE=/ABSOLUTE/PRIVATE/chart-display-rights.json
export QSYN_PRIVATE_CHART_SIGNING_KEY_FILE=/ABSOLUTE/PRIVATE/chart-signing.key
export QSYN_TRADING_ENABLED=0
export QSYN_ENABLE_LIVE_TRADING=0

# Start on a private Cloudways host, with owner-only 0700 socket folder.
private/app/bin/qsyn-private-chart serve 10444 /ABSOLUTE/PRIVATE/charts/market.ipc

# From the separately authorized operator process (not a public HTTP endpoint):
private/app/bin/qsyn-private-chart issue NFO\|CURRENT_LISTED_CE
```

The minted bearer ticket expires after 60 seconds, and the WS client must authenticate as its **first** text message:

```json
{"action":"authenticate","token":"OPERATOR_ISSUED_SHORT_LIVED_GRANT"}
```

The server responds with `authentication_success`, then `QSYN-PRIVATE-CHART-TICK/1` frames for *one authorized instrument*. A client cannot switch account/underlying on the same ticket. Staleness, content validation and account isolation are rechecked server-side. A forged, expired, revoked or cross-account token is rejected. The server closes connections when current rights become invalid.

**IMPORTANT:** Ticket issuance is operator-only in this release and is **not integrated with the PHP authenticated browser session**. Browser WSS exposure is therefore **NOT AUTHORIZED**. Do not add a public reverse proxy mapping to this loopback port until PHP session binding, CSRF/origin checks, TLS/WSS, proxy authentication, data-use legal restrictions and session revocation are independently implemented and tested. The QSYN public Studio remains SIMULATED and original OpenAlgo Charts UI unchanged.

To feed the private socket, use the `collect` command from `docs/PHASE4-BROKER-DATA-CHART-OMS.md`, after setting:

```sh
export QSYN_PRIVATE_CHART_IPC_ENABLED=1
export QSYN_PRIVATE_CHART_IPC_SOCKET=/ABSOLUTE/PRIVATE/charts/market.ipc
```

The broker worker does not mint any chart ticket. It only sends committed scoped quotes to the private Unix socket, and the receiving daemon enforces separate current display rights. If the socket delivery fails, the collector stops rather than falsely claiming continuous chart delivery. The WAL is the durable source of truth; the IPC is an **ephemeral** live delivery path.

## Cloudways Supervisor template

See `ops/cloudways/qsyn-private-feed.supervisor.conf.example` (included in DigiOps under `private/app/ops`). Its `autostart=false` protects against inadvertent market access after deployment; placeholders must be replaced outside GitHub. Install only after the Cloudways operator confirms service ownership, runtime compatibility, private Linux paths, broker process ports, exit codes, log directory permissions, crash reboot and rollback behavior.

Explicit acceptance requires all checks below:

1. Operator shows actual authenticated OpenAlgo `ping` for Upstox A and B, with distinct 0600 app keys and WS port pairs. Unauthorized or expired logins return denied state without token leaks.
2. Verify real CE/PE price/time evidence *against the upstream Upstox V3 `ltpc.ltt`*; do not relabel OpenAlgo `data.timestamp` as exchange-proven without independent proof. Confirm feed permissions cover storage **and** user display.
3. Run collector with approved scope and WAL; verify record count increases during a real market session. Restart/reconnect with the last snapshot; audit proves duplicate events did not increase persisted count. Perform torn-tail backup/explicit repair and cross-account refusal.
4. Create a licensed operator-only chart ticket; establish local WS loopback, verify one instrument only, account B denied, and live revocation immediately kills an existing A session. Repeat with separate viewer license.
5. Compare current provider leg history exported from OpenAlgo with source 1m candles, validate time zone, strikes and exchange calendar. Confirm actual *synthetic* highs/lows only from synchronized constituent ticks, not sum of per-leg OHLC.
6. Validate the order lifecycle with *mock* broker responses and risk-rejected paper orders, partial fill/cancel/reject and restart reconciliation. The real broker order mutating API is NOT invoked here.
7. Confirm unprivileged/anonymous public requests cannot reach private broker/WS/OMS, prove TLS and proxy security before enabling any user-facing data. Run persistent worker soak, data gap and latency metrics, backup restore and recovery drill.

## Production blockers after this code milestone

- Actual broker-owner login and broker/exchange entitlements cannot be granted from GitHub.
- The current code has **no authenticated PHP session → ticket endpoint**, no publicly exposed WSS, no automatic licensed chart backfill or browser datafeed adapter. These are separate work.
- The order state machine is **not a live order-routing adapter**. Live order submission, margin models, idempotent broker retries and exchange risk limits must not be enabled without sandbox certification and two-person operational release approval.
- A sample Supervisor config is **not** Cloudways operator installation, actual persistent process health monitoring, failover or disaster-recovery sign-off.

# QSYN Phase 4 — Broker auth, persistent feed, licensed charts, backfill, paper OMS

Baseline: operator-reported QSYN deployment #126, commit `1c9358e13bcb916165467a4efee17c0f7ef0b370`.
This PR changes **no original OpenAlgo/QSYN frontend, charts, styles, or buttons**.
Upstream OpenAlgo maintains the broker login UX and its trading API; QSYN uses
that authenticated service rather than collecting Upstox client secrets.

## What actually exists after this source release

| Requested capability | Code in this release | Reality before private operator acceptance |
|---|---|---|
| Actual Upstox account authorization | Existing separately scoped private OpenAlgo registry and authenticated ping/quotes. Authenticated Upstox broker login stays with original OpenAlgo OAuth/TOTP screens. | Requires account owner consent/login, token validity and a live private OpenAlgo process. CI runs only fake brokers. |
| Continuous feed worker | `qsyn-openalgo-feed collect` loops private OpenAlgo WS authentication, re-subscription and bounded retries until license expiry. Each valid quote is evaluated by a source/tenant/account/instrument/staleness gate. | Cannot start automatically from DigiOps. Requires a separately supervised restricted process and live authorization. |
| Rust persistent ingestion | New `PrivatePersistentIngest` fsyncs scoped quotes to the existing private WAL, drops reconnect duplicates and rejects stale/unlicensed/cross-account writes. | Approval must be a genuine, current market-data retention entitlement. No automatic licensed history recovery or backup is implied. |
| Authorized live chart subscriptions | `ChartSigner` issues/verifies five-minute HMAC tickets only with broker session **and** legal display attestation; `PrivateChartHub` fanout is keyed by tenant/account/instrument. | Backend primitives only; public HTTP/WSS chart listener and PHP user-session integration are **not yet activated**. Never send raw feed to public demo. |
| Real-market historical backfill | CLI-only authenticated OpenAlgo 1-minute leg-history export; Rust `qsyn-history-import` validates provenance and immutable indexed OHLC per constituent. | Operator must attest broker retention rights and run both utilities. Historical leg highs/lows cannot be summed into exact synthetic extrema. |
| Production OMS/risk | Durable, account-scoped **paper** order intents, idempotency, SHA-256 entry integrity, fsync, journal recovery, margin/notional/position caps, stale tick reject and kill switch. | No live broker order routing, no regulatory/risk approval, no server-account frontend route. Production **live** execution deliberately remains disabled. |

## Official provider contracts

- Upstox OAuth is delegated to OpenAlgo: <https://github.com/marketcalls/openalgo>.
- Upstox V3 is a **protobuf binary** market feed, **not** the JSON OpenAlgo normalized WS protocol. <https://upstox.com/developer/api-documentation/v3/get-market-data-feed/>
- OpenAlgo normalizes broker feeds via its independently authenticated WebSocket: <https://docs.openalgo.in/api-documentation/v1/websockets>
- OpenAlgo authenticated historical REST: <https://github.com/marketcalls/openalgo/blob/main/docs/api/market-data/history.md>
- All licensed/private operations are invoked from a local CLI. **No public market API or live order API is added here**.

## Installation / operator approval gates

Only after a qualified operator provisions independent, private OpenAlgo apps,
logs in to each real broker and verifies account permissions:

1. **Broker authorization**: separately sign into each actual Upstox/OpenAlgo
   instance; verify its private `ping`, real instrument key, current expiry
   and quote timestamp. Authorize Upstox A and B independently. Do not copy
   tokens between tenants or claim OpenAlgo login is exchange data licensing.
2. **Private persistence**: operator verifies exchange/broker retention terms,
   owner and account scope, and sets up an absolute 0700 canonical WAL folder
   outside webroot, same UID as worker, with sufficient storage.
3. The broker registry remains owner-only 0600, outside webroot, as specified
   in `docs/OPENALGO-PRIVATE-MULTI-BROKER-INTEGRATION.md`. The extra
   persistence approval file is also 0600, operator-attested **after checking
   actual permissions**. Example shape:

```json
{
  "schema": "QSYN-PRIVATE-PERSISTENCE-ATTESTATION/1",
  "tenant": "approved-tenant",
  "owner": "approved-owner",
  "account": "approved-upstox-account",
  "broker": "upstox",
  "license_id": "approved-license-id",
  "instruments": ["NFO|CURRENT_PROVIDER_CE", "NFO|CURRENT_PROVIDER_PE"],
  "persistence_approved": true,
  "broker_session_verified": true,
  "valid_until_ms": 1799999999999,
  "archive_root": "/ABSOLUTE/PRIVATE/market-wal"
}
```

This is a **schema example, not an issued permission**. The operator must use a
real entitlement identifier and **current** expiry. The file alone cannot
override any broker/exchange licensing restriction. Never check any real key,
license file or account identifier into GitHub.

4. Run `collect` **only on the isolated private server**, after verifying
   operational consent, the 0600 attestation and storage:

```sh
export QSYN_PRIVATE_BROKER_GATEWAY=1
export QSYN_PRIVATE_FEED_PROBE_ENABLED=1
export QSYN_PRIVATE_FEED_RUNTIME_ENABLED=1
export QSYN_PRIVATE_FEED_PERSIST_ENABLED=1
export QSYN_OPENALGO_REGISTRY_FILE=/ABSOLUTE/PRIVATE/openalgo-registry.json
export QSYN_PRIVATE_FEED_APPROVAL_FILE=/ABSOLUTE/PRIVATE/persistence-attestation.json

private/app/bin/qsyn-openalgo-feed collect \
  approved-tenant approved-owner approved-upstox-account \
  NFO:CURRENT_PROVIDER_CE,NFO:CURRENT_PROVIDER_PE

private/app/bin/qsyn-market-archive audit /ABSOLUTE/PRIVATE/market-wal
```

The collector continuously repeats finite WS observation sessions only while
the private attestation is in force; every reconnect demands fresh OpenAlgo
authentication. A service manager should restart unexpected failures with
bounded backoff, rotate logs, enforce CPU/memory limits, and stop at license
expiry. **DigiOps does not install or activate a service manager.**
A production multi-day soak, storage-capacity test, heartbeat alerting, and
restore/backup drill remain mandatory before labeling the worker production-ready.

## Private historical market-data workflow

Before importing any real historical bars, independently verify that the
signed-in broker allows local historical retention. Provide the operator-approved
0600 `QSYN_HISTORY_LICENSE_ATTESTATION_FILE`:

```json
{
  "schema": "QSYN-PRIVATE-HISTORY-RETENTION/1",
  "tenant": "approved-tenant",
  "owner": "approved-owner",
  "account": "approved-upstox-account",
  "broker": "upstox",
  "private_retention_approved": true,
  "license_expires_ms": 1799999999999,
  "instruments": ["NFO|CURRENT_PROVIDER_CE"],
  "license_id": "approved-license-id"
}
```

```sh
export QSYN_PRIVATE_HISTORY_EXPORT_ENABLED=1
export QSYN_HISTORY_LICENSE_ATTESTATION_FILE=/ABSOLUTE/PRIVATE/history-rights.json
php private/app/tools/private-history-export.php export \
  approved-tenant approved-owner approved-upstox-account \
  CURRENT_PROVIDER_CE NFO 2026-10-09 2026-10-09 \
  /ABSOLUTE/PRIVATE/export/ce-202610.json
export QSYN_PRIVATE_HISTORY_IMPORT_ENABLED=1
private/app/bin/qsyn-history-import import \
  /ABSOLUTE/PRIVATE/export/ce-202610.json \
  /ABSOLUTE/PRIVATE/indexed-candles
```

The importer only writes immutable **per-leg** 1m historical OHLC. Calendar
boundary and market-day exceptions must be checked; source dates here are
illustrative and need genuinely listed contracts. The provider export is a
historical REST request and does **not** prove independent trade-tick events
within each OHLC minute; exact synthetic OHLC needs aligned constituent ticks.

## Chart ticket integration boundary

`ChartSigner::issue` requires a short-lived external
`EntitlementAttestation` with current broker session, legal permission for
that user/instrument and a five-minute maximum validity. The HMAC secret is
never placed in the browser or deployment package. `PrivateChartHub::subscribe`
checks both HMAC and freshly supplied rights. `publish` denies cross-account,
cross-license, stale and forged exchange quotes. This is an **internal**
subscription bus; it deliberately does not create an anonymous public
WebSocket route. Integrate with PHP authenticated user sessions, tested TLS/WSS
and permission refresh **before** turning on any live UI selector.

## OMS safety

`PaperOms` is a strict **paper-only** ledger with durable fsynced fills and
restart integrity checks, not an OpenAlgo order adapter. It does not route any
broker mutation calls. Tests cover rejected stale fills, account isolation,
idempotent repeats, changing an existing ID, account recovery, oversized
position, margin/notional limits and the kill switch. Production live OMS
still requires server-side margin/exchange limits, authenticated intent
submission, state machine for sent/ack/partial fill/cancel/reject, tradebook
reconciliation, disconnection recovery and separate certified approval.

## Acceptance matrix

**Automatic in CI:** Rust/PHP lint and tests, 2 fake broker sessions,
WebSocket reconnection, HMAC scope/revocation, WAL writes/recovery, historical
bar import integrity, private account-scoped fanout, paper OMS safety,
Chrome original UI regression, DigiOps archive presence, download verification.

**Human/private validation:** Actual Upstox consent/authorization, supported
trade permissions, market data display and retention licenses, OpenAlgo/Cloudways
private worker deployment, real stream latency and gap recovery, PII/security
review, provider historical correctness, OMS/risk sign-off and exchange
compliance. No amount of CI can mark these passed without real evidence.

Until those private gates pass, the public QSYN `/studio` remains **SIMULATED**
and `QSYN_TRADING_ENABLED` / `QSYN_ENABLE_LIVE_TRADING` remain **off**.

# QSYN Phase 5 — Upstox private recovery and V3 historical leg backfill

**Code-ready, operator-only. Not proof of real broker connectivity.** Preserve PHP/Rust, owner-only JSON and durable binary WAL. No database server or Python runtime.

## Defects corrected

1. The V3 source worker previously exited outright if `GET /v3/feed/market-data-feed/authorize` failed transiently. It now retries temporary authorizer failures with bounded 2–30 second exponential backoff, obtaining a **fresh one-use redirect on each attempt**. Real broker HTTP 401/403 and failed identity, rights or private-storage validation remain terminal; never spin through revoked sessions.
2. WAL idempotency on reconnect could produce repeated chart datagrams after a duplicate tick was ignored by durable storage. Only **newly fsynced** quotes are now published to the private chart socket; replayed or duplicate timestamps remain invisible. Counts differentiate candidate quotes from newly persisted quotes.

## Licensed V3 intraday history (new)

`qsyn-upstox-history` is a one-shot, operator-only CLI. It invokes Upstox's documented V3 1-minute historical candle API **once per CE and PE** for an exact IST trading date, with the existing private account OAuth token from an operator-approved file and current mapped entitlement checks. It validates all returned ISO-8601 **+05:30** timestamps, sorted unique minute opens, exact session date, OHLC, volumes, response size and provenance. No demo candles are imported.

It writes separate **immutable, CRC-verified, 0600** `.qcb` option-leg archives in an existing, owner-only 0700 private directory, using instrument+calendar-day series IDs. The two independent leg files are not a cross-file transaction: an interruption after CE may leave an incomplete pair, which an operator must audit before any client could view it.

```bash
# The operator FIRST provisions actual OAuth, rights, BOD mapping,
# private file permissions and current contract expiry.
qsyn-upstox-history check /ABS/PRIVATE/config/worker-plan.json \
  /ABS/PRIVATE/history 2026-10-09

# Only after independent approval and private operator authentication:
QSYN_UPSTOX_HISTORY_ENABLE=1 QSYN_TRADING_ENABLED=0 \
  qsyn-upstox-history backfill /ABS/PRIVATE/config/worker-plan.json \
  /ABS/PRIVATE/history 2026-10-09
```

**Current public/private React charts do not yet query these history files.** The output is available only to the private operator until an independently authenticated HTTP history viewer with account-scoped rights, retention policy and matching WSS stream is approved and implemented. Do not call a private historical archive a visible live chart.

Authoritative provider documentation: [V3 Historical 1-minute candles](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/) and [V3 Intraday](https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/). Expired contracts and derivative availability are exchange/provider-constrained; an archive download cannot certify a listed contract or redistribution rights.

## Private process supervision

`ops/cloudways/qsyn-upstox-v3.supervisor.conf.example` is bundled but **autostart=false**. It shows a dedicated account-scoped worker, private gateway, loopback-only WSS port, owner-only runtime paths and **live trading disabled**. It cannot install/configure Cloudways processes, DNS or reverse proxy; those require Cloudways administrator/provider approval. Do not start the worker from a public PHP request.

To prove a production feed, the operator must independently record sanitized evidence for: a genuine Upstox account login/UCC, current CE+PE BOD keys/strike/expiry, display and retention entitlements, worker actually running after reboot, at least two authentic V3 Protobuf packets with distinct **ltpc.ltt**, provider `currentTs` and receive time, durable WAL sequence/watermark across restart, signed private chart WSS, expiry/revocation fail-closed, correct TLS path, and no order execution.

## Operator acceptance status

| Acceptance | Status after merging source |
|---|---|
| Source Rust unit tests / CI | Checked by GitHub workflows |
| Upstox OAuth on Cloudways | **Not verified** |
| Supervisor installed and reboot-tested | **Not verified** |
| Actual CE+PE exchange-timestamp stream | **Not verified** |
| Two-leg private historical archive | Implementation exists; **no real import verified** |
| Browser history and live chart | **Not complete** |
| Broker OMS activation | **Disabled** until approved order adapter and reconciliation |

Retain `QSYN_TRADING_ENABLED=0` and `QSYN_ENABLE_LIVE_TRADING=0`. Do not claim anything beyond code readiness without private operator evidence.

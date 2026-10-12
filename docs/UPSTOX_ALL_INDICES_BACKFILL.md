# QSYN all-index historical recovery — existing Rust runtime

The authenticated private Upstox index worker and historical importer are
already part of the **same qsyn-stream executable**. No new executable,
daemon, dependency, browser token forwarding, or public NSE/BSE API is needed.

The root deployment gap remains provisioning/updating the Cloudways operator's
private `QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1` plan with *every* exchange-approved
NSE/BSE index instrument for the account, and its current dated mapping and
licensed display/retention rights. A successful read-only Analytics Token
authorization does not establish those.

The existing `qsyn-upstox-index-history` runtime launcher now supports:

```bash
# Safe, no Upstox provider request or storage write:
qsyn-upstox-index-history check-all /ABS/PRIVATE/plan.json /ABS/PRIVATE/archive 2026-10-12

# ONLY after account/mapping/entitlements are independently approved:
QSYN_UPSTOX_INDEX_HISTORY_ENABLE=1 \
  qsyn-upstox-index-history backfill-all \
  /ABS/PRIVATE/plan.json /ABS/PRIVATE/archive 2026-10-12
```

Use the current Indian trading session date (IST) rather than blindly copying
the example. An approved operator may repeat the authorized batch for recent
dates within the existing 30-day bound; this is not yet an automatic scheduler.

The batch enumerates **only** the private plan's approved instruments (maximum
eight), without hard-coding broker keys, authorizing an unlisted symbol or
introducing fake candles. Each instrument passes the existing independent
provider-history token, current mapping, display/retention, file-permission
and ownership checks. Requests are serial to avoid unnecessarily increasing
Upstox request load. Historical candles are persisted in existing immutable
per-account candle partitions. When any import fails it stops, returns
`incomplete` and exits nonzero; earlier successful archives remain
idempotent and any unprocessed index remains pending.

**This does not start live V3 WSS.** Independently verify a current approved
worker plan using `qsyn-upstox-index-worker check PLAN`, explicitly enable
the operator supervised worker, authenticate the private history and WSS
reverse proxies, and inspect real exchange timestamps. No browser app or
developer token can make these host-side approvals automatically.

Run the existing CI, Rust format and DigiOps footprint guards. The CLI has
no new executable; the compatibility launcher uses the existing runtime
dispatch. Do not claim NIFTY/BANKNIFTY/SENSEX live until actual licensed
exchange-timestamped bars are observed on staging.

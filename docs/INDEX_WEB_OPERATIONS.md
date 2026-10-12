# QSYN — Web-based index operations

After deployment, open **Terminal → Data Providers & Connections → Indian indices · web operations**. This replaces repetitive manual Cloudways commands with browser buttons, using **only the already-packaged qsyn-stream executable and its ten tiny compatibility launchers**.

Available controls: Refresh readiness, Validate six-index plan, Import approved historical candles (chosen previous IST trading date), and Start/Stop approved index worker or private history reader. Results are bounded, redacted machine codes. The UI never accepts a shell command, remote URL, executable path, account ID, Upstox credential or arbitrary Supervisor program.

## One-time operator provisioning remains necessary

A web application cannot grant itself exchange rights or Cloudways privileges. An authorized Cloudways operator must first provision the existing private files and dedicated Supervisor policy. Use private file management and host configuration, not browser-submitted paths.

- `QSYN_UPSTOX_INDEX_WORKER_PLAN_FILE=/ABSOLUTE/PRIVATE/config/index-worker-plan.json` — existing owner-only 0600 file with approved current BOD, exact account and instrument mappings and independently evidenced NSE/BSE display and retention rights.
- `QSYN_INDEX_WEB_ARCHIVE_ROOT=/ABSOLUTE/PRIVATE/index-history` — existing 0700 owner-only directory.
 - Administrator-only, read-only **Validate six-index plan** is available without a second environment flag once the private executable/plan/archive are correctly provisioned. `QSYN_INDEX_WEB_OPERATIONS_ENABLED=0` is an explicit emergency kill switch.
- `QSYN_INDEX_WEB_OPERATIONS_ENABLED=1` — separately authorizes the website to request **state-changing** backfills and dedicated service controls, subject to their own flags.
- `QSYN_INDEX_WEB_BACKFILL_ENABLED=1` and `QSYN_UPSTOX_INDEX_HISTORY_ENABLE=1` — **optional separate approvals** for web-triggered historical imports using the existing Rust CLI; trading flags must remain disabled.
- `QSYN_INDEX_WEB_SERVICE_CONTROL_ENABLED=1` — **optional separate** worker control approval, only after the account/rights and Supervisor have been verified.
- `QSYN_INDEX_WEB_SUPERVISOR_CONFIG=/ABSOLUTE/PRIVATE/config/qsyn-index-supervisor.conf` — private 0600 owner-readable configuration for a **dedicated non-root index-only Supervisor instance**.
- `QSYN_INDEX_WEB_WORKER_PROGRAM=qsyn-upstox-v3-index-ACCOUNT_A` and `QSYN_INDEX_WEB_HISTORY_PROGRAM=qsyn-upstox-v3-index-history-ACCOUNT_A` — exact preapproved Supervisor names, never chosen by the web visitor.
- `QSYN_SUPERVISORCTL_BIN` may select only `/usr/bin/supervisorctl` or `/usr/local/bin/supervisorctl`. Do not give the PHP user general system Supervisor privileges.

The audited Supervisor processes must themselves have the existing enabling variables `QSYN_UPSTOX_INDEX_WORKER_ENABLE=1` and `QSYN_PRIVATE_INDEX_HISTORY_HTTP_ENABLED=1`, with scoped loopback listeners, private TLS ingress and exchange rights. Do not turn on `QSYN_TRADING_ENABLED` or `QSYN_ENABLE_LIVE_TRADING`.

## Safety and operational truth

The API route `/qsyn/api/v1/admin/index-ops/{status,check,backfill,start,stop}` is within the administrator same-origin session; write methods require CSRF and `confirmed=true`. Requests can choose **only** a bounded completed trading date (IST, within 30 days) and **worker/history** for start/stop. All paths/program names come from owner-provisioned server configuration. Commands run through `proc_open` argv (no shell) with timeouts, bounded output, a 0600 lock, and suppressed raw stderr. Browser reports never contain Upstox secrets, private paths or stdout.

The `backfill` button calls the existing **single-index Rust importer** once per approved instrument. The server selects the index key by ordinal from its private, Rust-validated plan; the browser cannot select a key, path or account. Each request is time-bounded (no long PHP job or new worker), and the browser advances through every approved index while displaying progress and candle counts. Browser disconnection or an error halts the sequence; previous account-scoped immutable archives remain and authorized operations may be retried. Completion of imports is **not** evidence of live streaming or public data rights. No simulated candles or redistribution are enabled.

An accepted Supervisor start command is **not** proof of a running worker or fresh exchange ticks. Refresh readiness, confirm actual process state, then verify the authenticated WSS and private historical reader with real NSE/BSE timestamps. The private chart gateway and reverse proxy are still separately controlled at the hosting layer; never expose raw loopback ports.

A missing plan, unknown account rights, unconfigured PHP operator permissions or Supervisor privilege fails closed. Web login alone is not authority to activate market-data distribution. The final acceptance condition is actual exchange-timestamped candles for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, INDIA VIX and SENSEX in authorized QSYN charts.

The host operator can disable the page's executable actions immediately by setting `QSYN_INDEX_WEB_OPERATIONS_ENABLED=0`. No new Rust service, binary or database is introduced.

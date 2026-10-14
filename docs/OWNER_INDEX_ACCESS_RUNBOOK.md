# QSYN NIFTY / SENSEX — owner-viewer preflight

The homepage does not require QSYN administrator login for **properly configured owner-only**, read-only index charts. It does **not** mean NSE/BSE OHLC is public. The source remains the account's authorized Rust/Upstox index reader.

## Understand the screen

If the homepage shows **Index source unavailable**, the chart itself is not evidence of a feed failure. The index adapter first checks `GET /qsyn/api/v1/owner-index/status`. If the owner path is denied it checks the separate authenticated administrator proof path; if both are denied the result is the generic overlay. No chart-layout change can fix a denied data source.

From the existing secure administrator session, open `/qsyn/terminal/diagnostics`, then click **Run secure audit**. Its JSON contains `owner_index_access.code` and boolean `owner_index_access.checks`. No actual IP, configured hostname, tokens, session cookies or private file paths are returned.

| Code | Remediation |
| --- | --- |
| `OWNER_VIEWER_DISABLED` | Explicitly provision `QSYN_PERSONAL_INDEX_OWNER_VIEWER=1` on the serving PHP application |
| `OWNER_INDEX_GATEWAY_DISABLED` | Check whether `QSYN_PERSONAL_INDEX_ENABLED=0` disabled the history/ticket gateway |
| `OWNER_VIEWER_TRADING_MODE_BLOCKED` | Keep `QSYN_TRADING_ENABLED` and `QSYN_ENABLE_LIVE_TRADING` disabled; owner-only chart mode never activates orders |
| `OWNER_IP_NOT_CONFIGURED` | Provision the intended owner IP via `QSYN_PERSONAL_INDEX_OWNER_IP` |
| `OWNER_REQUEST_IP_NOT_MATCHED` | Confirm the web server's actual trusted `REMOTE_ADDR` and the owner's configured IP. A Cloudways reverse proxy may cause a different peer address to arrive at PHP. Correct the trusted edge routing/configuration; **never** accept arbitrary client-supplied `X-Forwarded-For` |
| `OWNER_HOST_NOT_CONFIGURED` | Provision the exact approved `QSYN_PERSONAL_INDEX_OWNER_HOST`, including port only if the HTTP Host includes one |
| `OWNER_REQUEST_HOST_NOT_MATCHED` | Check that the Cloudways virtual host and pinned configured host exactly match |
| `OWNER_HTTPS_REQUIRED` | Correct HTTPS termination and the server's trusted HTTPS forwarding |
| `OWNER_VIEWER_ACCESS_READY` | The request passed the *viewer gate only*. Check private Analytics Token, Rust binary, browser history POST, source entitlement and true bar timestamps separately |

## Second-stage data-source verification

1. Confirm `GET /qsyn/api/v1/owner-index/status` returns schema `QSYN-PERSONAL-INDEX-OWNER-VIEWER/1` **in the owner's actual browser**. HTTP 403 means gate denied. This endpoint cannot attest index prices or streaming.
2. Using that same browser, observe `POST /qsyn/api/v1/owner-index/history` for the selected symbol/day. A 409 often signals that the private Upstox Analytics Token is not ready; a 503/502 requires checking private Rust runtime, executable, source response and application diagnostics. Do **not** paste secret cookies or authentication values into bug reports.
3. Only after the history endpoint returns provider-authenticated OHLC with proper market timestamps should the chart render. The backend must never substitute demo candles or bypass display rights to make the page green.
4. Verify both intraday history and account-scoped WSS updates under the same owner scope. `1s` is live only; historical backfill is 1m and above.
5. Deploy the exact tested main-branch artifact on Cloudways and verify that installed application files and Rust ELF correspond to that commit. GitHub Actions success alone does not prove the running deployment.

**Security boundary:** The normal denied owner response remains generic. Detailed failure codes live only in the authenticated diagnostics report. The diagnostics do not provision owner access, attest exchange redistribution rights, or activate live trading.

# QSYN native Upstox — current session and index V3 worker

## Admin browser flow

1. Log in with the existing QSYN administrator password at /qsyn/terminal/login.
2. At /qsyn/terminal/brokers select Upstox.
3. If the private token is stored, click **Verify current Upstox session**.
4. QSYN performs a new HTTPS GET to the official read-only Upstox `/v2/user/profile` API, validates `status=success`, `data.is_active=true`, and the exact expected Upstox User ID from the stored app configuration. All profile fields, token and Upstox identifiers stay private. The JSON response is sanitized.
5. A green result means **verified at the instant of checking**, not continuous token validity or data-licensing permission. On any 401/403, network error, inactive or mismatched profile, status remains unavailable. Reauthorize through Upstox if your token has expired; this verification does not renew tokens.

This is **not** OpenAlgo Python, OpenAlgo OAuth, a trading gateway or an exchange entitlement grant.

## Rust index worker (operator-disabled by default)

The new private binary is `qsyn-upstox-index-worker`. The **check** operation requires an existing owner-only 0600 JSON plan and all private prerequisites, but never connects. **run** additionally requires explicit `QSYN_UPSTOX_INDEX_WORKER_ENABLE=1`; Cloudways Supervisor example has `autostart=false` and `QSYN_UPSTOX_INDEX_WORKER_ENABLE=0`, so deploying the artifact cannot start real market ingestion.

Schema `QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1`: fields `tenant`, `account`, `owner`, `upstox_user_id`, `entitlement_id`, `instruments` (up to six objects with `exchange`, `symbol`, `instrument_key`), `rights_expire_ms`, `wal_root`, `private_chart_socket`, `private_rights_file`, `private_oauth_session_file`, `operator_approved_display`, `operator_approved_retention`, `current_bod_mapping_verified`, and `max_attempts`.

All approvals default absent. The private rights record must have the same account/owner/tenant/license, permitted current instrument keys, broker session attestation, user display entitlement, future expiry, owner-only 0600 mode and approved operator provenance. The current BOD mapping must correspond to Upstox's actual instrument-master keys. Do not treat examples like `NSE_INDEX|Nifty 50` or `BSE_INDEX|SENSEX` as proof that your exact contract/instrument list is current. Use the provider's current instrument master and approval documents.

The binary obtains a *fresh* V3 WebSocket one-use URL using the private Upstox bearer token, connects over WSS, sends a binary `ltpc` index subscription, validates Protobuf market status and timestamps, and sends only WAL-acknowledged, fresh authorized quote candidates through the existing **Unix datagram** ingress to the private chart WebSocket hub. Restarts and reconnects check rights and regain a new WSS URL. The raw provider URL, bearer token and quote payloads are never printed in worker logs. Unauthorized or expired plans fail closed.

**Remaining external acceptance gates:** Actual Upstox provider profile check with authorized account; current NSE/BSE index instrument master; exchange display/redistribution/retention rights; operator-approved 0700 WAL and runtime; Cloudways supervised Rust process and authenticated TLS WSS reverse proxy; chart grants and index history import/backfill. No operator starts, rights toggles, account-specific keys or real feeds are provisioned by the source PR. QSYN public chart homepage is unchanged; order execution disabled.

## CI and rollback

CI runs mocked profile success/expired/mismatch/permission cases; Rust index worker rejects missing rights and no private session; the existing Rust V3 decoder tests validate binary protobuf, replay rejection and market status; browser regressions check the admin terminal; DigiOps verifies the new PHP class and Rust executable after release artifact download.

Rollback: stop the privately supervised index worker, revoke Upstox token if compromised, disable approved display rights and revert the package if necessary. Keep the standalone chart homepage and public endpoints unchanged.

References:
- https://upstox.com/developer/api-documentation/get-profile/
- https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3/
- https://upstox.com/developer/api-documentation/v3/get-market-data-feed/

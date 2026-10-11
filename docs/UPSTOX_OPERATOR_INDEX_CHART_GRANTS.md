# QSYN operator-only private NSE/BSE index charts

## Why this route exists

The original `/qsyn/api/v1/terminal/private-chart-grant` is restricted to a
private mock development identity. Native Upstox OAuth uses a separate QSYN
administrator session. Logging into Upstox therefore cannot unlock that
mock-only grant. This implementation adds a deliberately independent,
explicitly enabled **single-operator** chart viewer. It does not establish
Upstox exchange market-data permissions and is not a multi-user identity
system.

## Disabled-by-default controls

All of these are mandatory and independently configured by a trusted
Cloudways operator. They are NOT included in the DigiOps release artifact:

- `QSYN_PRIVATE_OPERATOR_CHART_ENABLED=1`
- `QSYN_PRIVATE_CHART_GRANTS_ENABLED=1`
- `QSYN_PRIVATE_OPERATOR_CHART_HOST` = exact HTTPS ingress host
- `QSYN_PRIVATE_OPERATOR_CHART_TENANT` = independently assigned private tenant
- `QSYN_PRIVATE_OPERATOR_CHART_OWNER` = independently assigned operator/owner
- `QSYN_PRIVATE_OPERATOR_CHART_ACCOUNT` = precise Upstox operator account alias
- `QSYN_RUNTIME_DIR` = canonical private runtime directory
- `QSYN_PRIVATE_CHART_RIGHTS_FILE` = absolute 0600 owner-only file under
  `$QSYN_RUNTIME_DIR/upstox-private/`, with exact tenant, owner, account,
  instrument allowlist, broker=upstox, unexpired rights and explicit display
  permission. These are not automatically granted.
- `QSYN_PRIVATE_CHART_SIGNING_KEY_FILE` = absolute owner-only 0600, 32-byte
  signing secret under that same nonpublic directory, matching the existing
  private Rust WSS and index-history reader verifier.

`QSYN_TRADING_ENABLED` and `QSYN_ENABLE_LIVE_TRADING` must both remain off.

A secured QSYN administrator session with same-origin checks, secure cookie
and CSRF is required before obtaining any ticket. The `access` endpoint
reports authorization to *attempt* a scoped grant but intentionally returns
`private_rights_attested=false` and `live_feed_verified=false`.
The separate grant endpoint issues a 30-second index-only, account-bound
HMAC ticket only when the current rights file matches the independently
configured tenant/owner/account and exact instrument. It does not call
Upstox or enable the worker.

## Routes

- GET `/qsyn/api/v1/admin/upstox/private-chart-access`: admin-only access
  context, account alias and CSRF, no broker or signing secret
- POST `/qsyn/api/v1/admin/upstox/private-chart-grant`: JSON exactly
  `{"account_id":"<approved account>","instrument":"NSE_INDEX|Nifty 50"}`
  with the administrator CSRF in `X-CSRF-Token`

Only canonical `NSE_INDEX|` and `BSE_INDEX|` provider keys are accepted.
The existing development CE/PE mock identity issuer is unchanged. The
React Terminal first checks the operator endpoint and never silently falls
back to the mock identity after an operator 401/403 denial.

## Host operator acceptance

1. Confirm HTTPS, Origin/Sec-Fetch-Site controls, cookie policy, administrator
   session expiry, and static matching to the exact private chart rights
   owner/account. A server-side configuration file is NOT evidence of a real
   Upstox provider session or legally granted exchange market-data rights.
2. Independently validate current Upstox BOD mappings, actual account-scoped
   market-data display and retention permissions, operator worker liveness,
   private TLS WebSocket ingress and private historical reader.
3. Under a non-trading approved operator session, prove account mismatch,
   cross-origin POST, missing CSRF, expired/revoked rights, wrong key, unsafe
   file permissions and logout all deny grants.
4. During an authorized exchange session, verify two or more *actual* exchange
   timestamps, 30-second grant rotations, history provenance, and audit logs
   showing no broker token or public redistribution.
5. Before enabling general user accounts, design and independently review a
   proper user/account/tenant identity system; the single-operator issuer is
   not a production multi-tenant authorization service.

This feature remains inert until an operator enables it after those checks.

# QSYN #262 — Isolated OpenAlgo Upstox runtime and operator verification

**Status: source and operator acceptance tooling only. No Cloudways deployment, broker OAuth, user identity attestation, market license or live order approval is performed by this milestone.**

## Existing verified starting point

- QSYN chart homepage \`/qsyn/\` remains unchanged and trading is disabled **inside QSYN**.
- Broker catalog is live at \`/qsyn/api/v1/brokers/openalgo/catalog\` with 36 upstream plugin slugs.
- Native OpenAlgo is separately pinned and built from \`ops/openalgo/upstream.lock.json\` into the **qsyn-openalgo-foundation** artifact. It is NOT part of \`digiops-release\`.
- QSYN's development-only browser Connect flow remains disabled unless independently approved private identity and configuration exist. Do not enable it on public staging.

## Cloudways / Python host gate (mandatory)

1. Run the **read-only** \`ops/openalgo/host-readiness.sh\` as the application Unix user. The report always says \`host_approved=NO\`; do not treat detection of Python or Supervisor as approval.
2. Get written approval for Python 3.12+, native dependencies, one persistent non-root process, crash/reboot supervision, separated SQLite/DuckDB persistence, reverse proxy on a dedicated HTTPS hostname **at root** (\`/\`) and secure WebSocket/Socket.IO routing. Follow \`ops/openalgo/CLOUDWAYS-HOST-APPROVAL.md\`.
3. If Cloudways cannot approve this, deploy on a separately administered Linux host/VPS without modifying QSYN's Cloudways PHP deployment.
4. Run **one native OpenAlgo instance per broker account** with distinct UID or equivalent OS isolation, venv, persistent .env/database, REST port, WS port, app API key and HTTPS hostname. Do not re-use one Upstox broker account's app session for another tenant.
5. Extract the approved \`qsyn-openalgo-foundation\` build into private storage, **never** \`public_html\`. Verify pinned upstream SHA and release manifest; use the pinned OpenAlgo \`install/openalgo-gunicorn.sh\` launcher. The sample \`ops/openalgo/qsyn-openalgo-upstox.supervisor.conf.example\` intentionally has \`autostart=false\`; an authorized host operator must review its placeholder values, service dependencies and configuration before explicitly starting it. Do **not** run upstream's root installer on shared Cloudways unless approved.
6. Configure root-origin HTTPS and restrict the OpenAlgo login to the approved operator/owner. \`https://YOUR-APPROVED-OPENALGO-DOMAIN/login\` must route to the isolated instance. The real Upstox broker app's registered OAuth redirect must exactly match \`https://YOUR-APPROVED-OPENALGO-DOMAIN/upstox/callback\`, including hostname, scheme and path. Do not put broker keys, OTP, API key or refresh tokens in QSYN UI, query strings, CI, or this document.
7. Review *both* applications' execution permissions. Native OpenAlgo has order APIs; setting \`QSYN_TRADING_ENABLED=0\` **does not disable trading inside OpenAlgo**. Use broker sandbox/read-only access and independently review native OpenAlgo role/config/network/order permissions before real account login.

## Configure the existing private QSYN gateway

Only after an approved host and isolated Upstox instance are available, provision these **0600**, owner-matched files **outside public_html** under a 0700 private directory:

\`QSYN_OPENALGO_REGISTRY_FILE\` (private registry):

\`\`\`json
{
  "schema": "QSYN-PRIVATE-OPENALGO-REGISTRY/1",
  "accounts": [{
    "account_id": "upstox-a",
    "tenant_id": "approved-tenant",
    "owner_user_id": "approved-user",
    "broker": "upstox",
    "rest_port": 5000,
    "ws_port": 8765,
    "openalgo_apikey_file": "/ABSOLUTE/PRIVATE/upstox-a-app-apikey.txt"
  }]
}
\`\`\`

\`QSYN_OPENALGO_LOGIN_URLS_FILE\` (private login mapping):

\`\`\`json
{"schema":"QSYN-OPENALGO-LOGIN-URLS/1","accounts":[{"account_id":"upstox-a","login_url":"https://YOUR-APPROVED-OPENALGO-DOMAIN/login"}]}
\`\`\`

The API-key file contains OpenAlgo's **application API key**, not the Upstox OAuth access token or broker API secret. The example account ID, user, port and URL are illustrative. The login mapping permits only HTTPS FQDNs ending exactly at \`/login\`; it does not prove host ownership, TLS certificate, operator authorization or callback success.

## Run operator-only acceptance (no orders or raw market prices)

From an approved isolated CLI, with the above private files created and Unix file owner/modes verified:

\`\`\`sh
export QSYN_PRIVATE_BROKER_GATEWAY=1
export QSYN_OPENALGO_REGISTRY_FILE=/ABSOLUTE/PRIVATE/openalgo-registry.json
export QSYN_OPENALGO_LOGIN_URLS_FILE=/ABSOLUTE/PRIVATE/openalgo-login-urls.json
export QSYN_TRADING_ENABLED=0
export QSYN_ENABLE_LIVE_TRADING=0

php private/app/tools/openalgo-upstox-readiness.php inspect \
  approved-tenant approved-user upstox-a

# Existing read-only gateway, after successful broker login:
php private/app/tools/private-broker-gateway.php \
  read approved-tenant approved-user upstox-a ping
\`\`\`

Exit codes: \`0\` = a read-only OpenAlgo application session responds with the **expected plugin**; \`3\` = upstream session unavailable/expired (safe JSON negative result); \`2\` = invalid or unauthorized operator configuration (generic error without sensitive details).

The JSON is \`QSYN-OPENALGO-UPSTOX-OPERATOR-READINESS/1\`. Even success says \`upstox_account_identity_verified=false\`, \`broker_oauth_callback_verified=false\`, \`exchange_display_rights_verified=false\`, \`ready_for_live_market_data=false\` and \`openalgo_trading_permissions_verified=false\`. This is **not** proof that the correct Upstox UCC is logged in. Verify it separately in an authenticated OpenAlgo account/broker session, audit callback and expiration/re-login, obtain legitimate NSE/NFO data permissions, and then verify licensed account-scoped CE/PE ticks with real exchange timestamps.

## Acceptance sequence and rollback

- First: Cloudways host/process/TLS approvals, supervised restart and no public Flask/WS/ZMQ binds.
- Second: Isolated OpenAlgo setup and operator-controlled Upstox OAuth; no exposed credentials.
- Third: Private registry and login mapping ownership, proper account/tenant separation, read-only ping and negative cases.
- Fourth: Provider-confirmed broker UCC and display entitlement, up-to-date instrument master, controlled read-only CE/PE feed and WSS chart grant.
- Last: paper risk engine and authorized OMS certification *before* any live order activation.

Rollback: stop the isolated OpenAlgo instance through the approved supervisor, revoke/rotate its application API key and Upstox token through their respective providers, disable private browser Connect, keep \`/qsyn/\` unchanged. Do not remove or mutate QSYN private runtime state without a planned backup.

CI uses a local fake OpenAlgo \`/api/v1/ping\` endpoint and private temporary files; no actual Upstox credentials, account login or Cloudways access are provided.

# QSYN OpenAlgo Upstox: web-only operator verification

The administrator can now verify an installed OpenAlgo instance entirely from the QSYN React terminal. No CLI readiness command is required.

## Browser workflow

1. Open https://stage.digiti.in/qsyn/terminal/operations and sign in with the existing QSYN administrator password.
2. Open https://stage.digiti.in/qsyn/terminal/brokers, then select Upstox.
3. Select **Connect with OpenAlgo** for a configured account. QSYN checks the operator-approved private login mapping, then shows **Open approved OpenAlgo login**. Open the link and complete consent inside OpenAlgo (not inside QSYN).
4. Return to the Brokers screen and select **Verify session**. This makes a read-only authenticated server-to-localhost OpenAlgo ping. A responding session means only that OpenAlgo's configured API answered for the expected plugin. It does NOT prove Upstox UCC, callback verification, market-data permissions or safe order access.

Only an authenticated QSYN administrator with a valid HTTPS/same-origin session may use the API:
- GET /qsyn/api/v1/admin/openalgo/accounts: private non-secret inventory and CSRF.
- POST /qsyn/api/v1/admin/openalgo/connect: approved HTTPS native OpenAlgo login link.
- POST /qsyn/api/v1/admin/openalgo/inspect: sanitized local app session status.

Public broker discovery stays unchanged. Development/mock identity routes remain separately gated. Native OpenAlgo has its own live order APIs; QSYN_TRADING_ENABLED=0 does not disable those upstream endpoints. Restrict native OpenAlgo orders separately before authorizing a real broker.

## One-time private hosting prerequisites

The web screen CANNOT install or supervise Python, create Upstox credentials, approve exchange licensing or replace the upstream login. An authorized Cloudways operator must first provision the isolated service, its HTTPS root-origin reverse proxy/WS routing, broker-owned OAuth callback and private storage (see ops/openalgo/CLOUDWAYS-HOST-APPROVAL.md).

QSYN defaults to the existing private QSYN_RUNTIME_DIR for these operator-created owner-only 0600 files, unless the optional server environment variables name approved private file paths:

- openalgo-registry.json: schema QSYN-PRIVATE-OPENALGO-REGISTRY/1, account_id, tenant_id, owner_user_id, broker, loopback rest_port and ws_port, openalgo_apikey_file.
- openalgo-login-urls.json: schema QSYN-OPENALGO-LOGIN-URLS/1, mapping a known account_id to its trusted https://approved-domain/login.
- Per-account OpenAlgo APPLICATION API key file, 0600 and outside public webroot; never use an Upstox access token, broker secret or OAuth code in QSYN.

Files may be placed using a trusted private Cloudways file manager/SFTP; no terminal command is required for subsequent browser checks. The server checks the Unix file owner and mode and refuses unsafe or inconsistent registries. Never create files in public_html.

All account mappings are operator-managed. Self-service real multi-tenant Add Broker / production UCC verification still requires a separate production identity, secure onboarding and entitlement flow.

## Test and rollback

CI launches fake local Upstox responses and PHP admin-session HTTP tests, and rejects forged CSRF, origin, account names, upstream broker mismatch, secret leakage and insecure file modes. DigiOps packages the web API and checks its presence after downloading the artifact. No orders, broker authentication or live market price redistribution are activated.

Rollback by removing the private registry, disabling admin access, or restoring the last PHP/React release. The chart-only QSYN homepage is unchanged.

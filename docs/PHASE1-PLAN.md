# QSYN Phase 1 — Private identities and mock broker account control

Infrastructure baseline: **QSYN #58**, source commit
`673d9d28c090c1c915f1805eb9d4c7fbaa7360a9`.
The prior deployment, Rust auto-activation, and Supervisor crash recovery
tests passed on Cloudways staging. Historical rollback remains unverified.

This is an **offline development** phase. Preserve QNEXT isolation,
`trading_enabled=false`, `upstox_connected=false`, no broker credentials,
and the working Rust listener/Supervisor configuration. Avoid unnecessary
staging deployments while the private storage/auth architecture evolves.

## Implementation order and gates

1. **Mock linked-account repository (this PR)** — define the PHP
   `BrokerConnectionRepository` contract and a private FileStore-backed
   mock implementation. Create two independent Upstox mock links and one
   mock Dhan link for one user, plus different users/tenants. Disconnection
   requires the last known revision and preserves other account links.
   No public endpoint is exposed yet.
2. **QSYN user identity and sessions** — define test-only users and
   `UserRepository` contracts; hashed local test credentials, secure
   `HttpOnly` and `SameSite` sessions, CSRF checks, role assignments,
   login throttling and expiration. Keep this separate from the Rust
   operations-administrator account.
3. **Authenticated account APIs** — derive `tenant_id` and
   `owner_user_id` **only from a trusted session**, never caller-supplied
   JSON/query fields. Authorize list/get/link/disconnect, reject cross-owner
   IDs, and keep every actor/data operation audit scoped.
4. **Multi-account mock UI** — list/label/switch/disconnect Upstox A,
   Upstox B and mock Dhan. Clearly label all sources **simulated**;
   never display an execution button in this phase.
5. **Account-scoped chart contracts** — attach account/source identity
   to the OpenAlgo Charts feed boundary. Prove source switching cannot
   leak one owner's mock updates to another; maintain baseline demo chart
   rendering and instrument provenance.
6. **Release gates** — PHP and browser tests: unauthenticated 401,
   cross-tenant 403/404, stale-revision conflict, isolated link state,
   multi-account mock fixtures and retained runtime configuration. Only
   after these pass consider staging Phase 1; no real OAuth or live feed
   until separate provider, hosting and regulatory checks.

## This PR's implementation boundaries

`FileMockBrokerConnectionRepository` is an internal, test-only adapter:
- No Upstox OAuth, broker SDK, private keys, API tokens, real account IDs,
  real price subscriptions, orders or public account endpoints.
- Only `mock-` references and the `upstox`, `zerodha`, `dhan` codes
  are accepted. Account-specific integration identities are simulated.
- A deterministic UUIDv5 scopes each mock link to tenant, user, broker
  and reference so concurrent duplicate creation targets the same locked
  FileStore record. Distinct fake Upstox A/B connections are allowed.
- User/tenant checks are defense-in-depth at repository boundaries, **not
  a replacement for authenticating the caller at the HTTP boundary**.
- Collection enumeration is for low-frequency mock application metadata,
  never high-frequency market history or tick/quote data.
- Private file mode and revision checks remain those of the existing
  development-only FileStore. No claim is made of production-grade
  authorization, multi-process transactionality or secrets protection.

## Phase 1 exit criteria

One authenticated *test* user sees **Upstox A**, **Upstox B** and **Dhan**
mock identities, independent session/account health and independent
disconnect, while a second owner and second tenant cannot read, subscribe
or modify those identities. No production credentials or trade execution
are possible. CI passes without MariaDB, Redis, RabbitMQ or production Node.

## Phase 1.2 implementation: mock identity boundary

The following isolated development API endpoints are present:
\`GET /qsyn/api/v1/auth/state\`, \`GET /qsyn/api/v1/auth/me\`,
\`POST /qsyn/api/v1/auth/login\`, and \`POST /qsyn/api/v1/auth/logout\`.
There is **no signup, account-management API, OAuth, public fixture seeding,
trading, live market feed or Rust operations-control capability** in this API.

- **Disabled by default.** It requires *all* of
  \`QSYN_IDENTITY_ENABLED=1\`, \`QSYN_ENV=test|development\`, and
  \`QSYN_IDENTITY_STORAGE_DIR\` set to an existing private absolute
  directory outside the website document root, with no world permissions.
  Never enable this on a public or production QSYN installation. CI sets
  these only for its disposable localhost HTTP process.
- **HTTPS-only browser cookies**, named \`QSYN_USER_SESSION\`, with
  \`HttpOnly\`, \`SameSite=Strict\`, \`Secure\`, path \`/qsyn/\`, strict PHP
  session IDs, and ID rotation at login/logout. Only CI on localhost
  can opt into insecure HTTP via \`QSYN_ENV=test\` and
  \`QSYN_ALLOW_HTTP_TEST=1\`.
- Login requires \`Origin\` exactly matching the request host, same-origin
  Fetch Metadata when present, a 64-hex session CSRF token from \`state\`,
  \`application/json\`, and correct tenant/username/password. A private
  shared file lock permits at most five login attempts per source-IP +
  tenant + username within 15 minutes, independent of session cookies.
  Never trust a client-provided \`X-Forwarded-For\`.
- Fixture users exist only through *trusted PHP fixtures* using
  \`FileUserRepository::createFixture()\`; mock passwords are hashed
  with Argon2id when supported (otherwise bcrypt), stored in owner-only
  JSON files, and never returned in API responses. Duplicate identities
  are revision-protected. No self-registration is exposed.
- Session principal contains only tenant and user IDs; every authenticated
  request re-reads the private user record and invalidates disabled accounts.
  Session idle expiry is 20 minutes, absolute lifetime is 12 hours. Role
  policy is \`viewer < member < tenant_admin\`, scoped to one tenant, and
  cannot grant the separate Rust operations administrator's permissions.
- **Do not enable Phase 1.2 APIs on Cloudways staging yet.** Phase 1.3
  must bind account APIs to verified principal context and review the
  operation-level rate limit, audit, revocation and identity deployment
  controls first. The default deployed #58 Rust service remains unchanged.

The auth HTTP and repository contract tests run in GitHub Actions with
fake seeded users and temporary private storage, without MariaDB, Redis,
real credentials or live trading.

## Phase 1.3 — Authenticated simulated broker account API (development-only)

An additional **independent** gate \`QSYN_MOCK_ACCOUNTS_ENABLED=1\`
must be set in addition to all Phase 1.2 mock identity prerequisites.
Both switches default to off. This is not approved for public
Cloudways staging, live credentials, market-data entitlements or orders.

These internal endpoints require an authenticated \`QSYN_USER_SESSION\`:
- \`GET /qsyn/api/v1/accounts/list\` — account records owned by the
  current session user, plus effective selected account and revision
- \`GET /qsyn/api/v1/accounts/get?id=<mock-uuid>\` — owner-only lookup;
  foreign or missing records both produce \`404\`
- \`POST /qsyn/api/v1/accounts/link\` — mock broker code,
  \`mock-\` account reference and display label, returning \`201\`
- \`POST /qsyn/api/v1/accounts/rename\` — account ID, label, and
  \`expected_revision\`; CAS reject stale edits with \`409\`
- \`POST /qsyn/api/v1/accounts/select\` — account ID and
  \`expected_revision\`; one file-backed per-user selection, CAS updated
- \`POST /qsyn/api/v1/accounts/disconnect\` — account ID and record
  \`expected_revision\`; disabled chart source immediately becomes
  ineffective, but historical mock account metadata remains for auditing

Read-only \`viewer\` may list or inspect **only their own** mock
accounts. \`member\` and \`tenant_admin\` can write **only their own**
accounts, never arbitrary accounts in their tenant. Every mutation
requires an exact same-origin HTTPS request, same-site Fetch Metadata,
JSON body and the logged-in session CSRF token.

Tenant and owner IDs are **exclusively** derived from the verified
server-side session. Client attempts to submit \`tenant_id\`,
\`owner_user_id\` or execution/credential/role fields are rejected.
The broker codes are mock-only and every linked account has
\`execution_allowed=false\` and \`feed_entitlements=["simulated"]\`.
There is no link to a real OpenAlgo/Upstox process or any trading API.

Selection is stored in a single separate revisioned document rather than
changing "default" flags across multiple account documents. The account
must be mock-connected at selection, and the effective selection is
checked again on reads. This handles a concurrently disconnected account
without asserting multi-file transactions. An end-to-end authorized
chart feed and audit writer are **not** implemented in this slice.

GitHub CI executes the browser-equivalent HTTP regression with local
mock users, two Upstox references, mock Dhan, another QSYN user, another
tenant, a read-only viewer, malformed input, cross-owner requests,
wrong-origin or missing-CSRF denials and stale revisions. No public
enabling, dashboard, or staging deployment is part of this PR.


## Phase 1.4 — Browser mock-account workspace

The browser application lives at \`/qsyn/app\` and **does not replace**
the verified Phase 0 \`/qsyn/\` chart or the privileged Rust administrator.
It is **off by default**, requiring the independent
\`QSYN_DASHBOARD_ENABLED=1\` switch **plus** the Phase 1.2/1.3 mock
identity + mock account gates and a private developer/test data directory.

It must **not be enabled on public Cloudways staging** as the Phase 1
file-backed fixture system is not a production-approved multi-user account
service. GitHub browser tests use disposable PHP localhost and a fixed
test-only \`QSYN_ALLOW_HTTP_TEST=1\` override. Real hosts require HTTPS.

The HTML/CSS/JS dashboard:
- Logs in through \`/api/v1/auth/state\` + \`/api/v1/auth/login\`,
  with secure session cookies/CSRF inherited from Phase 1.2.
  No accounts can be registered or seeded via web routes.
- Lists authorized mocked Upstox A/B and another mock broker, with
  role-aware link, rename, select, disconnect, and sign-out controls.
  Account names are always inserted via DOM \`textContent\`.
- Selects **one** mock chart source via a versioned CAS record. On a
  source switch the browser reloads the isolated chart to prevent stale
  subscriptions/state from the previously selected account.
- Uses OpenAlgo Charts 2.6.0 through a **separate bundle**
  \`/assets/account-chart.js\`. Its history feed only calls
  \`GET /qsyn/api/v1/accounts/bars\` with the browser session cookie.
  **There is no account ID query parameter or accepted browser-supplied
  authorization context**. The server checks logged-in tenant, owner,
  effective selected account and \`mock_connected\` state before generating
  120 distinct but *fully synthetic* 1-minute OHLC bars. Responses always
  say \`source=account-scoped-mock-fixture\`, \`mode=simulated\` and
  \`trading_enabled=false\`. There are no real-time subscriptions.
- Does not wire QSYN's demo Rust quotes, OpenAlgo broker sessions,
  Upstox OAuth, subscriptions, market-data redistribution or order APIs
  to this demo.

Exit checks: Playwright drives login, three mock links, actual candle
pixel painting, versioned selection, source switch with different
fake candle data, disconnect revocation, viewer/tenant isolation,
cross-site safety and logout. Default-off dashboard route is validated
by PHP HTTP regression. **No staging deployment during this slice.**

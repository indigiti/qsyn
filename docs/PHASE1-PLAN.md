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

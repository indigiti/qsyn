# QSYN — OpenAlgo-first application adoption and charting cutover

**Decision:** 2026-10-10 · **Status:** approved product direction, **NOT installed or deployed**.
**Supersedes for future user-facing work:** the "standalone QSYN PHP demo is the product homepage" assumption in the Phase-0 README and `CHART-FIRST-TERMINAL-UX.md`. The latter remains an accurate record of a simulated prototype, **not** the target UI. `MASTER_BLUEPRINT.md` remains authoritative for account isolation, rust/feed storage, and financial safety; this addendum governs the app/UI sequencing.

## Product decision / definition of done

Adopt the *actual maintained OpenAlgo application* (Python Flask API and React frontend, including its native navigation, layouts, authentication surfaces, settings, charts, tools and broker workflows) as the foundation of QSYN, rather than approximating its look in another standalone PHP frontend. Keep OpenAlgo Charts as the chart rendering/widget library through supported interfaces. Add "QSYN Synthetic Studio" and future analytics as product extensions within the adopted shell, reusing native OpenAlgo styling and UX patterns. Preserve the independently maintained OpenAlgo upstream; pin, document and review any necessary integration patch rather than carrying an unexplained fork.

The **first QSYN public product screen** must be the accepted OpenAlgo-based experience. Legacy `/qsyn/` debug controls "Connect Rust demo", "Test Rust service", "Test demo stream", demo candle terminal and prominent Rust administration links must **not** be part of that product homepage. Move legacy diagnostics behind operator access and retain test endpoints only in a separate staging/QA context while migrating. A simulated, unauthenticated chart does not constitute a licensed, generally available market-data product.

Do not assert that OpenAlgo is integrated merely because `openalgo-charts@2.6.0` is installed: these are separate projects. Today QSYN `frontend/package.json` bundles only a custom ESBuild chart, account chart and Studio scripts; the DigiOps artifact packages the PHP frontend and Rust binary, not the OpenAlgo Flask/React application.

## Dependency-ordered work / gates

### Gate A — Upstream provenance and license (before any UI cutover)

- [ ] Record **tested, immutable** OpenAlgo git commit and OpenAlgo Charts release, with hashes/lockfiles, relevant licenses/notices and upstream upgrade policy. Do not build from unpinned `main` in production.
- [ ] Audit source licenses. OpenAlgo is AGPL-3.0; network-served modifications require corresponding-source compliance. OpenAlgo Charts is Apache-2.0. Preserve upstream attribution/branding and review trademark usage. Obtain legal review for QSYN's integration/derivative boundary.
- [ ] Verify Python >= 3.12, compatible Node engine for frontend build, build/test commands, OpenAlgo Flask app startup, `frontend/dist`, SQLite/DuckDB/native stores, broker callback URLs, WebSocket/ZMQ and reverse proxy requirements.
- [ ] Confirm host capability for **separate private, supervised Python service(s)** with secure outbound broker access and WebSocket upgrades. The current PHP-only DigiOps ZIP cannot by itself install or run OpenAlgo. If Cloudways cannot host the required processes, use an approved separate application host; do not expose Flask or broker credentials through public_html.

### Gate B — Install and smoke-test unmodified OpenAlgo privately

- [ ] Provision a **separate** service and native data/config dirs outside public webroot; verify least-privilege service user, persistent process manager, restart policy, log/backup policy and private secrets.
- [ ] Install a pinned OpenAlgo revision using upstream instructions; build the upstream React frontend. Preserve upstream database schema and authentication; avoid replacing it with QSYN mock file-storage or PHP's admin session.
- [ ] Serve the original OpenAlgo browser application behind TLS on an **internal/staging-only** origin with known proxy, cookies, CSRF/CSP and WebSocket behavior. Verify responsive sidebar, themes, login/setup, `/dashboard`, `/trading`, tools, symbol lookup, orderbook UI (without order placement), and refresh/deep-link behavior.
- [ ] Pass upstream smoke/unit/UI tests **and** independently check the built chart library version. No live credentials or exchange feed in CI.

### Gate C — Choose and validate one public routing integration

Target visible product URLs (subject to explicit base-path compatibility tests):
 
| User-facing purpose | Desired QSYN entry | Source |
| --- | --- | --- |
| Product home | `/qsyn/` | OpenAlgo-based app shell, **not PHP diagnostic page** |
| Charts | `/qsyn/trading` | OpenAlgo native Trading page / OpenAlgo Charts |
| Options tools | `/qsyn/tools` | OpenAlgo's native tools navigation |
| QSYN synthetic workspace | `/qsyn/synthetics` | New app route integrated into native layout |
| Account/portfolio/orders | Authenticated QSYN-adopted OpenAlgo app routes | Existing, only within verified account boundary |
| Operators | Private, access-restricted admin endpoint | Separate from public product |

**Important technical constraint:** Upstream OpenAlgo's React App uses `BrowserRouter` with root-relative paths (and its Flask APIs have their own paths). Publishing upstream assets at `/qsyn/` via a static path copy is **not sufficient**. Choose either:

1. An integration patch verified across Vite base, BrowserRouter basename, redirects, Flask REST routes, CSRF/cookies, OAuth callbacks, Socket.IO and WebSockets, with a reverse proxy that maps the path correctly; **or**
2. A dedicated QSYN terminal subdomain with the upstream app running at `/`; route `/qsyn/` to that terminal **only after acceptance**.

Both must preserve first-party API access, OAuth and WebSocket behavior. Do not introduce an iframe or fragile HTML/CSS imitation to conceal broken routing. Keep stage behavior unchanged until the selected route works in browsers after hard refresh.

### Gate D — QSYN extensions inside the adopted app

- [ ] Preserve native OpenAlgo sidebar/header, typography, responsive navigation, dark/light themes, common dialogs, symbol search, chart grid, indicators/drawings, watchlists/layouts and authentication UX, without reimplementing those features in PHP.
- [ ] Implement `QSYN Synthetic Studio` as an actual React page/route within the adopted app layout using shared components. Map CE+PE fixed ATM straddles, strangles, premium baskets and custom synthetic indices to the existing *scoped* Rust history/tick contracts.
- [ ] Keep all legacy browser-only simulated Studio features visibly labeled simulated until corresponding backend service/product tests pass. No mock account should be presented as authenticated broker connection.
- [ ] Use sanctioned feed/extension APIs to consume scoped history and live candle updates. Trading callbacks stay disabled unless separately approved; avoid leaking Upstox/OpenAlgo API keys into the browser.
- [ ] Decide ownership of QSYN user/workspace records before turning on multi-user access; single-instance OpenAlgo is broker-session-oriented and is **not** evidence of arbitrary multi-tenant broker account isolation.

### Gate E — Public charting acceptance, **after** OpenAlgo UI readiness

- [ ] Choose public chart data legal model: genuinely licensed redistributable platform feed, or individually authenticated account-scoped viewing with broker/exchange permission. **Do not equate broker OAuth or a passing WebSocket test with redistributable public-market-data rights.**
- [ ] Verify instrument IDs, CE/PE expiry and rolling rules, real exchange timestamps, source freshness, historical rights, source/account entitlement scopes, loss/reconnect/backfill/candle parity and no cross-account leakage.
- [ ] Exercise real *authorized* live charts only for permitted viewers; a no-credentials visitor must receive no private feed. Provide accurate disconnected/stale/simulated markers.
- [ ] Run Playwright desktop/mobile visual and functional acceptance for OpenAlgo homepage, sidebar, tabs, Trading, tools, Synthetic Studio, reload, WSS reconnect and 403/401 boundaries. Collect screenshots and logs with no secrets.

### Gate F — Orders and production release (separate safety gate)

- [ ] Durable server-owned paper OMS: intents -> reject/accept -> partial fill/fill/cancel -> reconciliation, replay, risk, margin, kill switches and explicit execution-account selection.
- [ ] Live order adapter only after private broker integration validation, user/account separation, approvals and production risk/reconciliation tests. No public chart or mock UI may implicitly enable execution.
- [ ] Cloudways/proxy and dedicated-service health, backups/restores, rollback, monitoring, rate limits, SLOs, legal/privacy/security sign-off.
- [ ] Switch `/qsyn/` only with passing acceptance and rollback-ready release. Remove test controls **from the public UI**; preserve private diagnostics and historical development evidence.

## Architecture: ownership and deployment separation

```text
Browser (OpenAlgo React UI / OpenAlgo Charts)
          |         |
       Flask UI/API  | QSYN scoped chart/history API
          |         |        |
        OpenAlgo     |     Rust service (WSS + WAL + synthetics)
          |                   |
  isolated broker contexts -> authorized Upstox / other providers
          |
  private native SQLite/DuckDB state

QSYN PHP control-plane/migration utilities remain isolated as needed;
they are NOT a substitute for the full OpenAlgo UI/Flask service.
```

OpenAlgo's native account login is distinct from QSYN's mock file-backed identity fixtures. Do not share a single OpenAlgo session among unrelated users, or copy broker secrets into the deployed static bundle. Source/tenant/account/entitlement labels must survive through read, subscription, cache and archive paths.

## Project sequence correction

| Sequence | Deliverable | Exit evidence | Status on 2026-10-10 |
| --- | --- | --- | --- |
| 1 | Pin and privately install **OpenAlgo full app** | Built React+Flask, native UI tests, process/host checks | **Not yet proven** |
| 2 | Deploy native UI as QSYN's accepted product shell | Homepage/nav/auth/chart/tool parity; proxy and deep-link tests | **Not yet proven** |
| 3 | Embed QSYN Synthetic Studio into that shell | Real React route, native UX parity, safe simulations | **Not yet proven** |
| 4 | Activate legally authorized chart feeds | Account-scoped real CE/PE, WSS, timestamps, backfill/reconnect verified | **Requires private acceptance** |
| 5 | Paper OMS then controlled live execution | Account isolation, audit/reconciliation, separate live approval | **Live trading off** |

The current PHP demo, OpenAlgo Charts widgets, mocked studio, Rust primitives, scoped history/WSS helpers and paper OMS components are **existing reusable work**, not a substitute for steps 1–4. Preserve them behind staging/tests during migration; remove obsolete public surface only when equivalent native routes pass acceptance.

## First implementation PR tasks

1. Introduce pinned and independently upgradeable upstream OpenAlgo **source/build/deploy** integration under private CI/release validation; preserve license artifacts. Do not start Flask from a public PHP request.
2. Verify upstream unmodified homepage/sidebar/trading/tools in browser on isolated staging origin and log compatibility failures.
3. Select route hosting strategy and add proxy/basepath tests before changing `/qsyn/`.
4. Integrate Synthetic Studio React route and adapter while leaving trading and unauthorized feeds off.
5. Only then replace the current visible debug homepage, with rollback to legacy staging for debugging.

**No claim of completion:** this document revises the roadmap. It does not install OpenAlgo on Cloudways, provide real broker credentials, assert market data licensing, deploy a public shell, or authorize live orders.

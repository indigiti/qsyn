# QSYN native OpenAlgo foundation — isolated installation runbook

**Status:** implementation candidate only. This workflow has **no** deployment credentials, **does not modify** the current PHP `/qsyn/` homepage, does not start OpenAlgo, and is not a broker connection. It produces a separate release artifact named `qsyn-openalgo-foundation`.

## What is in this release

- Upstream: `marketcalls/openalgo` at the exact commit in `ops/openalgo/upstream.lock.json` (currently `12e1114657981a3e50dde8c8ce04eb778ae1cf2f`).
- The complete **tracked** upstream Flask/Python source, native backend assets, scripts, project manifests and AGPL-3 license.
- A freshly built upstream React + TypeScript + Vite `frontend/dist`, with OpenAlgo Charts **2.6.0** installed via upstream's own lockfile.
- `OPENALGO-FOUNDATION-MANIFEST.json` with SHA, checksums, version and explicit `NOT_DEPLOYED` state.
- No untracked broker credentials, `.env`, runtime database, local user sessions, API tokens or Python virtualenv. The packaging script refuses to process upstream-tracked secrets and refuses a source SHA mismatch.

The artifact is the **actual OpenAlgo app**, not a new CSS copy of its trading UI. OpenAlgo itself is AGPL-3; modifications and network availability can trigger source-offer duties. Preserve attribution and have the public deployment's legal obligations reviewed. OpenAlgo Charts is separately Apache-2.0.

## Required private infrastructure (operator approval)

1. A Python **3.12+** process host with persistence for OpenAlgo native DB files, separate from QSYN PHP public_html. The upstream app needs Flask/Python, broker-specific workers, WebSocket/Socket.IO and internally scoped ZMQ; a static React bundle by itself is not an OpenAlgo installation.
2. An isolated server root with access only by a dedicated service user; the approved externally visible stage origin should mount the app at **/**, for example `https://terminal-stage.digiti.in/` **if** the domain exists and is under operator control. This is an example, not an existing deployed URL.
3. Private TLS reverse proxy routing regular requests to the loopback Flask port (default 5000) and the OpenAlgo WebSocket endpoint to its loopback WS port (default 8765); secure Socket.IO/WebSocket upgrade, cookies, CSRF, redirects, OAuth callback and CSP. Do not expose port 5555 / ZMQ, DB, WSS 8765 or Flask 5000 directly to the internet.
4. A persistent restricted supervisor with restart, quotas, backups and health alerts. Do not launch the Python service from QSYN PHP or reuse the PHP Rust administrator session.
5. No real broker keys or market data until owner-driven OAuth, authorized data rights and identity-isolation tests pass.

**Why a dedicated root-origin instead of placing the UI at `/qsyn/` now?** The unmodified React application has root-relative BrowserRouter routes, plus root-relative Flask REST, Socket.IO and broker callback URLs. A static-path copy under `/qsyn` would break route reloads, assets, session/CSRF/OAuth and WS. Root mounting on a dedicated domain permits the original interface without fragile code changes. `/qsyn/` can later link/redirect to this accepted origin, or we can design and test an explicit upstream base-path integration. Neither action is made by this PR.

## GitHub packaging verification

- Open a PR touching `ops/openalgo/**` or this workflow, or manually dispatch **QSYN OpenAlgo Full Application Foundation**.
- Confirm **Pin, build and package native OpenAlgo application** passed, including source pin checks, offline fixture tests, upstream `npm ci` and `npm run build`.
- Download `qsyn-openalgo-foundation` from that run. Extract `qsyn-openalgo-foundation.tar.gz` in a trusted **private** staging directory and inspect the manifest. Confirm `openalgo/app.py`, `openalgo/License.md`, `openalgo/frontend/dist/index.html` and native React assets. Do not extract into `public_html/qsyn`.
- The existing `digiops-release` artifact remains the legacy PHP/Rust distribution and is **not** modified by this flow.

## Private install (after host and provider approvals)

These are **operator reference steps**, not automation executed by CI. Prefer the upstream's current container/install guidance to suit the approved host. For a Python host, inside the extracted private OpenAlgo tree, use Python 3.12 and OpenAlgo's native dependency lock; one reference is `python3.12 -m venv .venv`, then `.venv/bin/pip install -r requirements-nginx.txt` where that requirements file suits the provisioned platform. Node and `npm ci` are not required on the production host because `frontend/dist` is already included. Set up the upstream `.env` **privately** with owner-only 0600 permissions, distinct fresh secrets, permitted service ports and staging hostname. Keep all provider credentials and native DBs off public webroot.

Run the upstream-supported managed Flask service and separate feed/WS components according to the host's configuration; verify the service supervisor and WSS proxy actually work. Preserve upstream SQLite/DuckDB migrations and state. Never copy QSYN demo file-backed accounts into real OpenAlgo sessions.

## Acceptance before any cutover

- [ ] Build workflow green at an identified QSYN SHA, with upstream commit and manifest hashes verified.
- [ ] Native OpenAlgo starts on approved private infrastructure and survives controlled restart (not merely an installed ZIP).
- [ ] HTTPS staging origin shows original OpenAlgo setup/login, dashboard and sidebar, theme switch and responsive layout.
- [ ] After a test-only permitted login, native `/trading`, chart drawings, indicators, symbol search, layout and `/tools` routes work. Hard-refresh/deep links, cookie/CSRF and asset loading must work.
- [ ] WS upgrade, Socket.IO behavior and correct 401/403 behavior under disabled broker access pass. No browser receives arbitrary broker tokens.
- [ ] Confirm whether provider license permits anonymous public charting or restrict to authorized account-scoped data. No shared live feed without explicit rights.
- [ ] Only then add the QSYN Synthetic Studio React route under the native app layout; maintain the legacy mock studio privately until feature parity.
- [ ] Product homepage handoff has accepted screenshots/Playwright traces, rollback and monitoring. **Do not replace `/qsyn/` before these gates pass.**

## Explicit exclusions

No production Node server, MariaDB prerequisite, Rust manager permission change, server-side PHP code change, Cloudways password manipulation, automatic frontend homepage switch, broker authorization, real CE/PE live data, active trading or production account provisioning is performed here. CI success establishes a **buildable upstream installation artifact only**.

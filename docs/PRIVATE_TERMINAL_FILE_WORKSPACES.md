# QSYN milestone — private account-scoped file workspaces (developer-only)

**Date:** 2026-10-10. **No database, Python server, broker tokens, or live orders.** The existing `/qsyn/terminal` defaults to browser-local workspaces and simulated charts.

## Why this gate exists

Browser `localStorage` is shared by everyone using the same browser origin. It is not tenant-isolated. To avoid copying account-owned layouts into that shared key, the new workspace feature explicitly separates **browser** and **private authenticated** modes. Private layouts remain in React memory until the user explicitly writes them to a separate, owner-scoped file.

## Private endpoint

`GET/POST /qsyn/api/v1/terminal/workspace`

The endpoint is enabled **only** when `QSYN_TERMINAL_FILE_SYNC_ENABLED=1` AND the existing development identity gate `IdentityApi::privateRoot()` grants a private root. The identity gate requires `QSYN_IDENTITY_ENABLED=1` and `QSYN_ENV=test` (loopback HTTP with explicit test flag) or `QSYN_ENV=development` (explicit approved private staging host over HTTPS). Ordinary `stage.digiti.in/qsyn/` remains unaffected unless the operator independently approves and configures its private ingress.

Requests inherit the existing separate `QSYN_USER_SESSION` cookie; the user identity is revalidated from disk on every call. The endpoint derives `tenant_id` and `user_id` solely from the session and **never** accepts them in query/body/header. Viewer role permits read; member or tenant-admin role permits writes. POST requires exact JSON fields `expected_revision` and `workspace`, a matching same-origin `Origin`, an authenticated CSRF token, a positive session, limited request size, a whitelisted simulated instrument schema and valid widget-state bounds. Revision mismatch returns HTTP 409. A file-backed HMAC mock audit journal records write intent/rejection/completion without request bodies.

Storage is **one private JSON record per owner and tenant**, under `terminal_demo_workspaces/tw_<SHA256-prefix>.json`, with private 0700 directories, 0600 records, CAS revisions and atomic rename via `FileStore`. There is no database daemon, and this low-frequency file store is **not** used for market ticks or execution orders.

## UI behavior

- With the feature off, the terminal continues working as before, using only localStorage.
- With a private authenticated session, a separate control allows explicit **Load private file**, **Save private file** (member+) and **Return to browser**. There is no automatic upload or download.
- Loading a private file switches React state to `private` and does not copy the account's content to unscoped `localStorage`. Changes are only in memory until an explicit save.
- A stale revision is rejected by the backend (409), with a user-facing instruction to refresh private state before retrying. The client does not silently overwrite another session's edits.
- Returning to browser reloads the existing unscoped local workspace; private content is discarded from React state.
- The unmodified public simulated charts are still available without authentication; private storage never authorizes Upstox data, WSS, or orders.

## CI acceptance

`python3 apps/web-php/tests/TerminalWorkspaceHttpSmoke.py` covers default-off gating, actual mock login, viewer denial, revoked session, same-origin and CSRF, forge attempts, simulated instrument allowlist, file modes, revision conflicts, audit events, and cross-owner/cross-tenant separation.

`node --test frontend/tests/terminal-file-sync.test.mjs` covers safe client responses, same-origin requests, revision conflicts, and absence of owner/tenant authority fields.

`node frontend/tests/browser-terminal-smoke.mjs` additionally mocks a successful private-session endpoint and confirms importing data never writes it into shared `localStorage`; it also confirms server-write bodies are bounded to workspace and revision.

## Explicit exclusions and further gates

This remains a **mock/development identity** solution, not general public multi-tenant production authentication. Production requires approved identity/session management, encryption and key rotation where applicable, per-account broker entitlement, reliable backup/restore, quota control, conflict UX, private ingress verification and account/symbol-level data permissions. Running the PHP development identity endpoint publicly or exporting scoped layouts into a shared anonymous browser profile would violate the intended boundary.

No cutover of `/qsyn/`. Do not change homepage until OpenAlgo UI parity, authenticated chart subscriptions, and staging end-to-end acceptance are signed off.

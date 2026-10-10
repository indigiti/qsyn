# QSYN production-readiness specification

Baseline: main at a46f2c208590 (2026-10-10). Status: implementation in stages; no production authorization implied.

## User goal
Deliver QSYN as an independently secured, multi-user, multi-broker synthetic options and charting platform that preserves the existing original OpenAlgo Charts UI/UX. Do not redesign or replicate the upstream OpenAlgo trading app.

## Functional requirements
- FR-001 Retain existing chart widgets, toolbars, indicators, drawings, responsiveness and simulated Studio behavior.
- FR-002 Support multiple independent broker identities per tenant/user, including two separate Upstox accounts plus another broker. Each provider runtime must have isolated credential and port context.
- FR-003 Use upstream OpenAlgo's authorized login/OAuth and broker adapter facilities; keep tokens/keys outside webroot and never publish them in browser bundles or build artifacts.
- FR-004 Provide private, read-only, per-account diagnostics that distinguish service reachability, broker authentication, source freshness, market-data entitlements, distribution authorization, chart availability and trading permission.
- FR-005 Ingest only approved broker events into account/tenant/entitlement-scoped Rust pipeline, recovery WAL, historical candles and synthetic series.
- FR-006 Maintain server-owned identity, entitlement checks, account-scoped history and subscriptions for authenticated chart users; prevent cross-tenant feed leaks.
- FR-007 Implement persistent paper order lifecycle, bounded risk checks, audit and idempotency before attempting any broker order integration.
- FR-008 Treat real order entry as a separately approved stage requiring explicit user account selection, signed-off operator risk policy, broker/exchange authorization and independently tested sandbox.
- FR-009 Build release acceptance with PHP, Rust, browser, security, load, restore, rollback and verified DigiOps package tests. Cloudways real-world checks are separate operator attestations.
- FR-010 Never infer market redistribution rights, live trading permission or exchange freshness solely from an OpenAlgo ping or received tick.

## Nonfunctional requirements
- Fail closed on missing identity, expired broker authorization, stale events, missing entitlements, wrong symbol/account context, or ambiguous routing.
- No browser-supplied private filesystem paths, tokens, command execution, arbitrary broker URLs or unrestricted order operations.
- Keep PHP mock/file mode database-free for local test; production data stores require separate security approval.
- Preserve source/receive timestamps, exchange session, contract version and provenance, including historical reconstruction assumptions.
- Observability never logs or echoes secrets; connections fail independently.

## Acceptance
A. Offline fake-provider tests prove account isolation, redaction, denial of mutations, readiness and failure isolation.
B. Build, browser and release gates pass; no UI change unless separately approved.
C. Real dual-Upstox and third-provider OAuth, per-user feed permissions, restored state, WebSocket reachability and execution approval remain pending until operator-backed evidence is attached.
D. Live trading stays disabled until independent risk, sandbox, broker and compliance checks pass.

## Explicit exclusions from current offline implementation
Broker sessions are not created in CI; Cloudways, exchange licensing, user-specific approvals and genuine live prices/orders cannot be established solely through a GitHub commit.

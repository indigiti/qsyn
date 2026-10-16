# Implementation tasks

Status legend: [x] source change committed on this branch; [ ] pending build, execution or externally validated gate.

## Batch 1 — repository-safe readiness
- [x] T001 Inspect main baseline and current broker CLI/source interfaces.
- [x] T002 Specify preserving OpenAlgo UI, tenancy and real-data/trading gates.
- [x] T003 Add CLI-only scoped readiness summary with loopback ping and no keys or market prices.
- [x] T004 Add fake-provider regression checks for tenant exclusion and failed-provider handling.
- [ ] T005 Validate complete PHP and Rust/Chromium CI on PR and artifact after GitHub runs.
- [ ] T006 Prove Cloudways private OpenAlgo deployment, owner/ACL and two authorized Upstox instances.

## Batch 2 — account and feed
- [ ] T007 Implement authenticated account lifecycle and token expiry/revoke transitions using upstream OpenAlgo.
- [ ] T008 Implement strictly authorized continuous provider feed ingest and reconnect/reconcile.
- [ ] T009 Connect scoped Rust ingestion, WAL writer, immutable history, backfill and provenance.
- [ ] T010 Add signed, entitlement-scoped history and WebSocket chart APIs and UI-preservation tests.

## Batch 3 — lifecycle and execution
- [ ] T011 Add durable paper OMS with risk/idempotency/audit.
- [ ] T012 Add realistic options IV/OI/Greeks and server-owned alerts with data-quality labels.
- [ ] T013 Complete sandbox order lifecycle and kill switch with explicit account selection.
- [ ] T014 Seek independent approval before any real trading enablement.

## Batch 4 — infrastructure and sign-off
- [ ] T015 Restore/rollback drill, secret rotation, network ACL, performance and load evidence.
- [ ] T016 Publish verified DigiOps package; operator deploys and validates Cloudways.
- [ ] T017 Update readiness matrix only against actual evidence (CI logs, live broker auth and production attestations).

## Non-goals of Batch 1
No UI redesign, external brokerage credentials, real OAuth execution, public broker API exposure or real trade enablement.

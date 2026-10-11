# QSYN cross-layer reliability audit — 2026-10-12

Base inspected: `6ba4a519f78a8cb1fa9d54a49ad462a1b99483c5`. Scope: repository tree (273 entries), PHP entrypoints and private capability dispatch, React chart lifecycle and workspace state, Upstox discovery, Rust worker packaging, GitHub CI, DigiOps and read-only staging acceptance. Static review plus regression tests proposed in this branch; **not** an independently executed penetration test, running Cloudways audit, or broker-certification report.

## Verified findings and targeted corrections

| Severity | Finding | Change |
|---|---|---|
| P1 reliability | Browser-only workspaces automatically GET the optional private development API, generating expected but noisy HTTP 503 in ordinary use. | Remove mount-time probe; explicit operator click probes private storage. |
| P1 diagnosis | Every HTTP 503 from the private workspace endpoint is represented as `disabled`, even when modules are absent or an upstream/proxy fails. | Classify only the explicit `private_terminal_workspace_disabled` JSON code as disabled; other 503s remain offline/unavailable. |
| P2 chart | Expected OpenAlgo abort rejection reporting may occur after the chart-effect's queued observer cleanup, resulting in an unhandled `AbortError`. | Attach the existing **exact-message-and-name** observer for the lifetime of the React application. Do not suppress unknown errors, HTTP problems or CSP violations. Follow-up upstream handling remains recommended. |
| P2 tests | Dashboard direct-route Playwright assertion uses `!pathname === string` and therefore can never reject a wrong URL. | Correct strict inequality, and exercise explicit private-file opt-in. |
| P2 CI | Rust formatting step runs `cargo fmt` in place, which can conceal formatting failures. | Run `cargo fmt -- --check`. |
| P2 deployment evidence | Public acceptance on push is hard-coded to old #78 SHA, although artifact/runtime already advanced. | Require operator-supplied full deployed SHA on a manual read-only workflow invocation. |
| P3 documentation | README claims that source modules for native Upstox OAuth and WAL do not exist. | Correct distinction between implemented source and operational/entitlement gates. |

## Findings intentionally **not** changed

- Upstox's `resolved_for_review` and its six NSE/BSE underlying keys are **not** proof of current BOD, CE/PE contracts, chart display/retention rights, feed activation, or any trading authorization. No entitlement or order gate is relaxed.
- `script-src 'self'` remains unchanged. The reported inline-script CSP violation needs a *captured rendered response* and clean-profile comparison to attribute a Cloudways/WAF/browser-extension injector; source PHP uses a local external script.
- Cloudways `wafcl` broken pipes need correlated origin/edge logs, not speculative firewall removal.
- PR #93's missing `Search` import is already merged. Rust ingestion, private chart grants, OMS, worker supervision and real-market continuity require a separate operational acceptance test.
- Existing `README.md` and `infrastructure/DIGIOPS.md` contain historical Phase-0 material. This pass corrects key contradictory status claims but is not an end-to-end historical-document migration.

## Automated acceptance

GitHub PR CI should pass PHP unit/smoke, Rust fmt/clippy/test, React build, chart/cancellation contracts and Chromium smoke including configured Upstox Brokers, dashboard routing, and manually checked private workspace sync.

## After merge

Deploy only an exact green DigiOps artifact matching the intended SHA. Confirm the runtime deploy with DigiOps, inspect the actual workspace endpoint's sanitized response, and test CSP in a clean browser against the live authenticated document. Use `QSYN Public Staging Read-Only Acceptance` by manually entering the **full confirmed deployed SHA**. Do not enable real feeds, redistribution, identity or trading to satisfy a test.

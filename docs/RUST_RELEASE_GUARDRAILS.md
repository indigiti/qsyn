# QSYN Rust footprint & performance governance

## Verified baseline (2026-10-12)

- Main source SHA: 6d84e9ebf297c28b42e8261253df75a9aace63a4
- DigiOps artifact: 11727871652, 3,661,122 bytes compressed.
- Release directory contains **one** Rust ELF (5,430,976 bytes raw) and
  **ten** fixed command launchers with execute permissions.
- Shared OHLC helpers handle geometric validation; crypto trade volume and
  synchronized synthetic observations remain semantically distinct.

## Non-negotiable release rules

1. QSYN ships exactly one compiled Rust ELF at
   private/app/bin/qsyn-stream. Additional Rust source modules are welcome,
   but additional Cargo binary targets, implicit src/bin entrypoints, custom
   build scripts or deployable ELF copies are **blocked** by CI unless the
   architecture and guard policy undergo explicit review.
2. Existing operator modes and Supervisor entrypoints use fixed launchers;
   each mode retains independent private process, entitlement, credential,
   approval, tenant and trading gates. One executable does not mean one shared
   privileged process or one account.
3. Rust release profile must retain strip, optimized LTO, low codegen units,
   and non-debug/production optimization. These safeguards catch accidental
   build configuration regressions; they do not guarantee runtime speed.
4. The verified release has hard **budgets**: 6,500,000 bytes for the raw ELF,
   4,400,000 bytes for the estimated level-9 payload ZIP, and 4,500,000 bytes
   for the GitHub artifact ZIP. Size budget changes must include measurements,
   justification and an approved PR; don't silently raise thresholds.
5. CI checks source/Cargo/build configuration, release checks the staged
   file set and compressed size, and downloaded-artifact verification checks
   the produced release. Unit tests mutate target lists, flags, launchers,
   permissions and limits to prove failures are enforced.
6. Adding a broker adapter should reuse scoped market events, shared OHLC
   rules, bounded subscriptions, explicit observation vs. volume semantics,
   and the existing binary via an explicit reviewed operator mode. Never
   infer Upstox/NSE/BSE license rights or automatically start private feeds.
7. For performance-sensitive Rust changes require representative throughput,
   memory and reconnection/backfill measurements alongside existing tests.
   Compare identical workload, machine and warm-up conditions; no noisy
   wall-clock microbenchmark is an automatic CI release gate.

## Required repository administration (separate from source code)

The .github/CODEOWNERS file requests review by @indigiti for Rust,
pipeline and budget policy changes. **CODEOWNERS alone is not enforcement.**
In GitHub Settings > Rules > Rulesets (or branch protection for main):

- Require a pull request and code-owner review for protected paths.
- Require the successful check named "Rust footprint guard" and the regular
  Rust CI and DigiOps release checks before merge.
- Restrict direct pushes and bypass permissions to explicitly approved
  maintainers; disallow force pushes and deletions.
- Keep default release workflow attached to all pushes on main so DigiOps
  receives an artifact attested to the exact source SHA.

The repository's ruleset list was empty at audit time; the GitHub connection
could not read branch-protection configuration. The above administrative
controls must be enabled by the authorized repository owner separately.
Do not claim they are enabled merely because this document is merged.

## How to inspect locally

    python3 ops/rust_footprint_guard.py source .
    python3 -m unittest discover -s ops -p test_rust_footprint_guard.py -v
    python3 ops/rust_footprint_guard.py staging staging
    python3 ops/rust_footprint_guard.py artifact digiops-release.zip

A failing guard intentionally prevents packaging. For a genuine new Rust
capability, first document the reason and expected CPU/RAM/ZIP impact, then
update code and any explicitly approved policy change together in a reviewed
PR. Never weaken checks or remove entitlement gates as a quick fix.

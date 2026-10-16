# QSYN OpenAlgo Charts 2.6.4 compatibility re-audit

Date: 2026-10-14 (IST)  
PR: https://github.com/indigiti/qsyn/pull/146  
Scope: **QSYN frontend only**; no production dependency changes until this PR is merged.

## Versions and source boundaries

- Frontend `openalgo-charts` exact dependency: `2.6.0` -> `2.6.4`.
- The separately packaged native OpenAlgo application stays on commit
  `12e1114657981a3e50dde8c8ce04eb778ae1cf2f` with Charts `2.6.0` in
  `ops/openalgo/upstream.lock.json`.
- No Rust binaries, Upstox OAuth/session handling, WebSocket wire formats,
  historical fetch schemas, trading gates, or synthetic OHLC/Wick calculations
  are changed in this PR.

## Re-audit findings and fixes

OpenAlgo Charts 2.6.3 changed widget defaults to horizontal mouse pan and
right-side wheel zoom. QSYN's 2.6.0 behavior must not change implicitly.

All **eight** QSYN `createWidget` / `createChartGrid` mounts now explicitly set:
- `zoomAnchor: 'cursor'` (the prior default);
- `mousePan: 'horizontal'` for the seven widgets/grids where QSYN had
  explicitly chosen horizontal dragging before this upgrade;
- `mousePan: 'both'` for the previously unconfigured *PrivateMarketPanel*
  to retain its existing horizontal+price dragging behavior.

The first review missed `frontend/src/studio.js`,
`frontend/src/terminal-strategy.jsx` and the private market pan setting.
These were corrected. The candidate's Node regression now enumerates every
mount, rejects unreviewed new mounts, checks the installed module is actually
2.6.4, preserves the separately locked OpenAlgo application, and guards raw
minified bundle sizes.

## Upgrade behavior not activated merely by changing the dependency

**Session-aware historical navigation (2.6.2):** The `DateNavigator` gap
correction requires a trustworthy `sessionCalendar` for each instrument.
QSYN's current private NSE/BSE history feed does not supply an exchange holiday
and special-session calendar to the chart. This PR must therefore **not** be
described as fixing Indian index holiday-gap warnings or missing Rust candles.
A separately sourced, maintained exchange calendar with accurate holiday
exceptions and special trading sessions is needed before enabling that benefit.

**Saved state (2.6.3):** The upgraded widget changes layout migration semantics
for old navigation settings (uses version-stamped layout state). QSYN's explicit
host defaults and the existing browser workspace tests protect the expected
baseline; manually inspect previously saved user workspaces before deployment.

**Footprints (2.6.1 and 2.6.4):** Their order-flow/imbalance data requires
genuine trade and bid/ask evidence. Neither the five-strike synthetic OHLC
series nor 1-minute provider OHLC is sufficient to represent authentic
footprint prints. No footprint-based signals are enabled in this PR.

**Performance:** CI verifies minified JS bundle budgets, alongside existing
Rust-footprint protections. These checks do not replace on-device latency
or live-tick throughput benchmarks.

## Acceptance evidence and remaining release gate

Automated checks include the frontend esbuild production build, version and
navigation contract, simulated chart painting, homepage crypto backfill and
Wick Science, browser workspace persistence, desktop/mobile terminal smoke,
PHP/HTTP contracts, Rust synthetic tests, and DigiOps archive assembly.
Use the current PR checks for the exact revision under review; prior green
runs do not certify later commits.

Still required before staging/production promotion:
1. A real browser using the candidate artifact: mouse pan, cursor zoom,
   auto fit, drawing controls, saved layouts, mobile and 1D/3D/7D/Go To.
2. Authorized Upstox/Rust index streaming on the actual owner account:
   no fabricated bars, monotonic timestamps, 1-second live ticks and
   1-minute candle consistency across reconnect/recovery.
3. Weekend/holiday navigation with a *verified* session calendar; do not
   suppress genuine missing trading-session data.
4. Actual bundle download and startup-time comparison with the pinned 2.6.0
   release on the same device/network.

**Release policy:** Keep the PR as draft until the runtime acceptance
requirements are met. GitHub Actions can produce a release archive for
review without authorizing a production deployment.

## Dependency reproducibility

`frontend/package.json` pins the direct chart package exactly, but the repo
does not currently commit a `frontend/package-lock.json`: CI uses
`npm install`, not `npm ci`. Transitive dependency resolution therefore
remains less reproducible than a lockfile-backed install. This pre-existing
repository issue should be resolved in a separately scoped dependency-lock
change (especially before regulated production release), rather than
accidentally changing all transitive packages inside this chart-only upgrade.

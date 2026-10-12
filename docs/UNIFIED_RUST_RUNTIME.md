# QSYN unified Rust executable rollout

## Principle

OHLC is a shared data shape, not an exchange-authority guarantee. Public
crypto exchange-reported OHLCV and licensed private NSE/BSE / CE+PE observations
must retain their different provenance, scopes and entitlement checks.

The release packages one Rust ELF at `private/app/bin/qsyn-stream`. Ten small
POSIX launchers keep existing operator paths and Supervisor command strings
compatible without adding additional linked Rust libraries to the artifact.

Examples (no worker starts without its existing private settings/enable flags):

```sh
private/app/bin/qsyn-stream
private/app/bin/qsyn-stream ctl status
private/app/bin/qsyn-stream mode qsyn-market-archive audit /ABSOLUTE/PRIVATE/ARCHIVE
private/app/bin/qsyn-stream mode qsyn-upstox-index-worker check /ABSOLUTE/PRIVATE/PLAN.json

# Legacy entry points remain exact-mode wrappers:
private/app/bin/qsyn-upstox-index-worker check /ABSOLUTE/PRIVATE/PLAN.json
```

### Operational safeguards

* Single executable **does not** mean one running process. Supervisor may run
  multiple copies with separate loopback listeners, users, credentials, settings,
  observability and restarts.
* The public `qsyn-stream` default mode still exposes only the intended
  loopback-local service; operator modes require explicit `mode NAME` or a
  fixed-argument private compatibility launcher.
* Worker-level environment flags, licensing, chart grants, key files and
  private scope validation are unchanged. No new index feed or trading rights
  are granted by a compiled binary being present.
* Before promoting the artifact, confirm DigiOps applies executable permission
  to the `qsyn-stream` ELF **and** its POSIX launchers after extracting the
  Actions artifact. The reviewed workflow artifact ZIP has executable-mode
  entries, but host-specific extraction behavior can differ. Confirm modes
  and smoke-test a launcher on the staging host; packaging alone is not
  evidence that an existing Supervisor worker can restart.
* The release ZIP no longer contains separately compiled ELF workers. For
  rollback, redeploy the previous attested release and restore approved
  Supervisor configuration if necessary. Never start two workers on the same
  loopback port or delete private persisted credentials/archive files.

### Acceptance gates

1. Rust cargo test, Clippy and formatting pass.
2. The existing standalone CLI tests still pass, and the unified dispatcher
   rejects unapproved empty-mode startup for all ten worker modes.
3. Artifact audit shows exactly one Rust ELF and ten small private launchers.
4. Public crypto candles/health and Rust daemon lifecycle smoke tests pass.
5. Operator verifies approved Supervisor worker identity, private directories,
   strict permissions and index-rights gates on the target Cloudways host.
6. Verify actual NSE/BSE WSS ticks/timestamps and rights separately. This
   optimization does not claim those services are activated.

## Shared OHLC invariant

The Rust `market_pipeline::valid_ohlc` contract now validates positive finite
prices and consistent open/high/low/close bounds for public crypto exchange
candles and privately calculated synthetic observations. `Candle::observe`
is the shared synthetic price-aggregation primitive in both the scoped basket
and private OpenAlgo basket; the latter retains separate close-out and gap
detection. None of these helpers authorizes a feed or fabricates volume.

Exchange-reported crypto volume stays a separate field. Synthetic
`observations` are *counts of synchronized premium observations* and must
never be shown as executed trade volume. Broker credentials, BOD instrument
keys, exchange entitlements, access grants and historic data retention remain
restricted to their adapters. Historical crypto bars stay exchange-authoritative.

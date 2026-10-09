# QSYN Phase 0 — Supervisor binary activation contract

This is a staging-only foundation test. Broker connectivity and trading remain disabled.

## Existing Cloudways contract

- DigiOps publishes `private_html/qsyn/app/bin/qsyn-stream` by staging and
  atomically renaming a replacement onto that path (never `copy()` over the
  executing inode).
- Cloudways Supervisor owns the sole foreground `qsyn-stream` process,
  listens only at `127.0.0.1:10251`, and configures
  `autostart=true` and `autorestart=unexpected`.
- Supervisor must inject `SUPERVISOR_ENABLED=1` and
  `SUPERVISOR_PROCESS_NAME=qsyn-stream`. The activation watcher is disabled
  for manual, direct-mode, or mismatched processes.
- The Rust watchdog compares `/proc/self/exe` device/inode identity against
  the absolute executable path every five seconds. If the published path now
  points at a different regular-file inode, only that Rust process exits 75,
  an unexpected exit for Supervisor. Supervisor then launches the published
  binary. There are no PHP shell calls, open restart APIs, cross-service signals,
  or modifications to QNEXT.
- Missing `/proc`, unreadable paths, and symlink destinations disable/skip
  the watcher rather than stopping the process.

## First rollout and later upgrades

The currently running Release #52 binary predates this watcher. The **first**
deployment containing the watcher will still require a one-time controlled
Supervisor restart. Do not mistake filesystem publication for activation.

After first restart, query the read-only diagnostics endpoint and verify
`auto_activation: true`, `runtime_commit` equal to the deployed release's
40-character source SHA, and `runtime_version` populated. If
`auto_activation: false`, do not claim unattended activation; verify the
Supervisor environment with Cloudways.

Subsequent changed-binary upgrades may restart automatically after atomic
publication. A same-byte release may be skipped; no restart is required.
Service interruption during an actual upgrade is expected until Supervisor
restarts and the localhost health endpoint returns 200.

## Acceptance checks before enabling feature development

1. GitHub CI tests supervised/non-supervised binaries with real on-disk
   `os.replace`, confirms code 75, and relaunches the new executable.
2. Release artifact embeds its exact GitHub SHA in `runtime_commit`.
3. On staging, after the first controlled restart, confirm
   `auto_activation: true` and `runtime_commit` matches the artifact.
4. With a **different** verified binary release, confirm DigiOps publishes it,
   Supervisor restarts `qsyn-stream`, and the new commit becomes active.
5. Separately test unexpected-exit recovery and rollback to the recorded
   known-good artifact, including restart and identity verification.

Do not mark steps 3–5 passed from repository CI alone. Do not change the
Supervisor unit, public ports, admin secrets, or QNEXT for these checks.

## Staging acceptance: first unattended upgrade after Release #54

Known-good staging baseline: `QSYN #54`, artifact `11643953373`,
running commit `fee07ef502975663369b00f9fbe871a3a8732b14`.
Cloudways verified `auto_activation=true`, Supervisor `RUNNING`,
and the localhost Rust health response. Record the existing PID and
`uptime_seconds` immediately before deployment.

The next test release is deliberately a minimal **test-only** change under
`services/`, so the new Rust binary contains a distinct embedded source SHA
without changing HTTP routes, demo quote behavior, or broker/trading capability.
Only the artifact produced by the **merged main** commit is eligible for the
staging test; the PR's pre-merge artifact has a different identity.

Deployment test:
1. Confirm the new artifact's source SHA and GitHub checks, and confirm current
   diagnostics still report the #54 baseline with `auto_activation=true`.
2. Deploy the next release from DigiOps, with **no manual** `supervisorctl
   restart`. Allow the running watcher to detect the atomically replaced inode.
3. Observe `supervisorctl status qsyn-stream`: it should be `RUNNING` with a
   **new PID**, started by Supervisor after the watcher exits 75.
4. Confirm the direct localhost `/health` and public PHP diagnostics both
   report `runtime_commit` matching the newly deployed **40-character SHA**,
   `runtime_version=0.1.0`, `auto_activation=true`, `demo_ws_enabled=true`,
   and `trading_enabled=false`.
5. Run two-quote simulated WebSocket test. Save the before/after diagnostics
   as evidence. No feature-development signoff until these checks pass.

If DigiOps reports deployed but the old commit still runs, **do not
manually restart and claim unattended activation passed**. Record the
Supervisor and Rust logs and diagnose whether atomic replacement occurred.
If health fails or the new binary does not stabilize, use the controlled
recovery/rollback procedure, not a server-wide restart.

Supervisor recovery and rollback to #54 are **separate acceptance tests**.
Never assume they pass from the upgrade alone.

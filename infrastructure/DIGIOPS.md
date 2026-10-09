# QSYN x DigiOps — Phase 0 deployment contract

The DigiOps interface shows:
- public browser route: /qsyn/
- application public directory: public_html/qsyn/
- application private directory: private_html/qsyn/
- artifact lookup name: digiops-release

This repository contains the matching .github/workflows/release.yml.
It creates a release *artifact only*. It does not modify Cloudways or assume DigiOps is already linked to this repository/workflow.

## Artifact contents

~~~text
digiops-release/
  public_html/qsyn/index.php
  public_html/qsyn/assets/chart.js
  private_html/qsyn/src/FileStore.php
  private_html/qsyn/bin/qsyn-stream
  private_html/qsyn/metadata/build-sha.txt
~~~

The binary is for the runner's Linux target; confirm target architecture, glibc, and Cloudways compatibility. Do not make it executable as a public CGI script. Private application state and credentials must live outside the release extraction path so releases cannot overwrite them.

## DigiOps configuration and safety gates

1. Link DigiOps to the **QSYN repository's** QSYN DigiOps Release workflow. A DigiOps console's own commit SHA is not proof that the QSYN app has deployed.
2. Trigger and inspect GitHub Actions CI + release artifact. Confirm artifact digest, SHA and extracted folder paths.
3. Test PHP route /qsyn/ and /qsyn/api/v1/health after a staged deployment.
4. **Do not** start Rust/OpenAlgo daemons until the host permits supervised long-running processes and secure private networking/WSS proxy routes. They are not required for the PHP simulated chart demo.
5. Never expose the OpenAlgo port, Upstox API keys, arbitrary local Rust admin endpoints or private user-store files to the internet.
6. Upgrade OpenAlgo and OpenAlgo Charts through pinned versions, compatibility tests and reviewed staging releases. Do not replace OpenAlgo's SQLite/DuckDB stores during the release.
7. Establish immutable release backups, storage snapshots and rollback ownership before production cutover.

The static JS chart bundle uses build-time Node tooling only; there is **no Node.js production server**.

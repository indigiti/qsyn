# QSYN × DigiOps — deployment artifact contract

DigiOps' own installation documentation supports a release-root public/index.php entrypoint (or dist/index.html, index.php, index.html). It does not recognize the former nested public_html/qsyn/index.php as the artifact entrypoint.

Documentation: https://github.com/indigiti/DigiOps/blob/main/docs/INSTALL.md

## DigiOps target configuration

- Browser route: /qsyn/
- Public deployment destination: public_html/qsyn/
- Private deployment destination: private_html/qsyn/
- Artifact name: digiops-release

These Cloudways destination prefixes are configured in DigiOps, NOT embedded in the ZIP. DigiOps maps release/public to public_html/qsyn and release/private to private_html/qsyn.

## Exact ZIP paths

~~~text
public/
  index.php               # app entrypoint
  .htaccess               # include-hidden-files: true required
  assets/chart.js
  licenses/openalgo-charts-LICENSE.txt
private/
  app/src/FileStore.php
  app/bin/qsyn-stream
  build/release.json
RELEASE.json
~~~

GitHub Actions stages these paths and uploads an artifact named digiops-release. A separate verify-artifact job downloads the ZIP and confirms public/index.php, .htaccess, the compiled chart JS and the manifest exist.

### Explanation of ENTRYPOINT_MISSING

The earlier artifact had public_html/qsyn/index.php *inside the ZIP*. DigiOps only accepted entrypoints at documented release-root paths. The earlier workflow also omitted include-hidden-files: true, which excluded .htaccess. Both are corrected by the new release workflow.

## Review and deployment checks

1. Confirm both QSYN DigiOps Release jobs, package and verify-artifact, pass on main.
2. In DigiOps click Check update and verify the new exact workflow run, SHA and digiops-release artifact.
3. Deploy the verified Phase 0 payload; inspect /qsyn/ and /qsyn/api/v1/health.
4. Leave Rust in private/app/bin as a compiled artifact only, NOT a public CGI script. Daemon supervision/WSS proxy and Cloudways capabilities still require verification.
5. Keep persistent storage and credentials outside release-managed paths.
6. No live Upstox connection, trading, or real broker secrets are enabled in Phase 0.

The OpenAlgo Charts JS is built in GitHub Actions. No production Node.js server is required.

## Browser-based Rust testing (Phase 0)

The QSYN chart page at /qsyn/ now includes a **Test Rust service** button. It calls the read-only PHP endpoint /qsyn/api/v1/diagnostics/rust. No SSH session is needed to inspect an already-running Rust daemon.

- online: PHP verified the expected Rust /health response and checked the private demo WebSocket handshake.
- offline: no compatible service is reachable on the fixed loopback address 127.0.0.1:1299, even if the binary has been deployed.
- demo_disabled: the optional Rust demo WebSocket is disabled (expected default).
- demo_enabled: the optional WebSocket handshake returned 101 Switching Protocols.
- unexpected_response: the port returned something other than the expected Rust service identity.

The browser never connects directly to localhost on the user's computer. PHP checks a fixed localhost port with strict timeouts and no arbitrary URL parameters, process execution or credentials. The UI checks only when the user clicks the button.

Security: the Phase 0 endpoint exposes only non-sensitive status. Before introducing real user credentials or live trading, protect operational diagnostics using QSYN administrator authentication and authorization. The endpoint must not execute/start/stop processes.

The button does NOT start the daemon. DigiOps packages the executable under private_html/qsyn/app/bin/qsyn-stream but does not yet launch or supervise it. Cloudways may therefore report offline; this is an accurate state report, not a UI error. Enable persistent startup only after validating Cloudways process permissions, restarts, isolation, and private routing.

GitHub Actions starts temporary PHP and Rust processes in CI to test offline/online states and the WebSocket handshake; it then shuts them down. No real broker data or production credentials are involved.

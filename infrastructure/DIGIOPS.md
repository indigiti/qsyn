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
- offline: no compatible service is reachable on the fixed loopback address 127.0.0.1:10251, even if the binary has been deployed.
- demo_disabled: the optional Rust demo WebSocket is disabled (expected default).
- demo_enabled: the optional WebSocket handshake returned 101 Switching Protocols.
- unexpected_response: the port returned something other than the expected Rust service identity.

The browser never connects directly to localhost on the user's computer. PHP checks a fixed localhost port with strict timeouts and no arbitrary URL parameters, process execution or credentials. The UI checks only when the user clicks the button.

Security: the Phase 0 endpoint exposes only non-sensitive status. Before introducing real user credentials or live trading, protect operational diagnostics using QSYN administrator authentication and authorization. The endpoint must not execute/start/stop processes.

The button does NOT start the daemon. DigiOps packages the executable under private_html/qsyn/app/bin/qsyn-stream but does not yet launch or supervise it. Cloudways may therefore report offline; this is an accurate state report, not a UI error. Enable persistent startup only after validating Cloudways process permissions, restarts, isolation, and private routing.

GitHub Actions starts temporary PHP and Rust processes in CI to test offline/online states and the WebSocket handshake; it then shuts them down. No real broker data or production credentials are involved.

## Browser Start / Stop / Restart — opt-in and administrator-only

The Phase 0 QSYN website includes an **administrator-only Rust service controls page**:

- \`https://stage.digiti.in/qsyn/admin/rust\`
- Start, Stop, Restart and Refresh status for the one fixed program \`qsyn-stream\`.
- Separate read-only "Test Rust health" button connects through PHP to \`127.0.0.1:10251\`.
- No SQL, Redis, RabbitMQ or production Node.js server required.

**IMPORTANT:** This page does NOT bypass Cloudways restrictions or create a service manager. Its action buttons remain disabled unless the operator explicitly enables admin control and Cloudways provisions a local, restricted supervisorctl integration. No request accepts a shell command, PID, custom program, executable path, hostname or arbitrary URL. Only the fixed \`qsyn-stream\` process can be managed.

### Server-side configuration (Cloudways Support / hosting administrator)

The following environment variables must be injected **privately into PHP-FPM** (never into public files or GitHub):

~~~text
QSYN_CONTROL_ENABLED=1
QSYN_ADMIN_PASSWORD_HASH=<bcrypt/Argon2 password_hash, generated on server>
QSYN_SUPERVISORCTL_BIN=/usr/bin/supervisorctl
QSYN_SUPERVISORCTL_CONFIG=/absolute/private/path/to/qsyn-only-supervisorctl.conf
~~~

Generate a password hash in PHP CLI using \`password_hash\` (do not write the plaintext password to logs or terminal history). \`QSYN_SUPERVISORCTL_BIN\` may also be \`/usr/local/bin/supervisorctl\`; other executables are rejected. The config must be an existing readable, non-symlink absolute file. Cloudways must ensure PHP can access **only a qsyn-stream-restricted supervisor endpoint**, not an unrestricted global root socket.

See [Supervisor reference](supervisor/qsyn-stream.conf.example). The provider must install the real Supervisor program under its approved process-management setup with application-specific absolute paths, a private log directory and appropriate permissions.

Cloudways [documents PHP execution functions as disabled by default](https://support.cloudways.com/en/articles/7891624-how-to-enable-php-functions). \`proc_open\`, \`proc_get_status\`, and \`proc_terminate\` must be supported for the opt-in adapter to operate. Do not indiscriminately enable every disabled PHP function; request the narrowest approved integration. If the host does not allow it, buttons remain disabled; deploy a separate restricted service controller instead.

### Admin session protections

A valid \`password_hash\` is required. Session cookies are Secure, HttpOnly and SameSite=Strict, scoped to \`/qsyn/\`; session IDs rotate at login, and sessions expire after 20 idle minutes. Every state-changing request requires an authenticated administrator session, strict-origin check, POST JSON and a per-session CSRF token. Stop and Restart also require a browser confirmation. The server applies five-attempt lockout per session; place this path behind an additional Cloudways IP allowlist or WAF/rate limit before enabling it on a public internet hostname.

The status endpoint never returns shell output, private configuration paths, broker credentials or raw process logs. A successful supervisorctl command indicates only a **management request accepted**, not a passed health check; confirm using the separate Rust health probe. Controls are initially off and remain off if any configuration or capability check is missing.

**Host permission remains unverified:** Nothing in the QSYN artifact or this panel starts Rust automatically. Production daemon setup must be confirmed by Cloudways and independently tested. Do not enable on the public staging hostname with real trading credentials until administration and privileges have been reviewed.

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


## Direct Rust lifecycle mode (without Supervisord)

QSYN additionally supports **opt-in direct mode**, where the Rust executable safely
self-detaches and accepts fixed CLI lifecycle actions. This mode does not use
Supervisord, systemd, sudo, shell execution, QNEXT processes, or public ports.

- Web admin: https://stage.digiti.in/qsyn/admin/rust
- Dedicated Rust engine executable: private_html/qsyn/app/bin/qsyn-stream
- Listening address: 127.0.0.1:10251
- Management interface: \`qsyn-stream ctl start|stop|restart|status\`
- Private runtime files: private_html/qsyn/runtime/qsyn-stream.pid,
  qsyn-stream.control.lock and qsyn-stream.log.
- Starting the service uses Rust's native detached child with a new POSIX session,
  closed standard input, and output redirected to a private log file.
- Status and Stop validate the current PID's Linux /proc executable identity AND
  managed process marker before signalling it. An exclusive file lock serializes
  web requests and prevents two simultaneous launches. No arbitrary PIDs or programs.

### Server-private opt-in

Ask Cloudways to inject the following into this **QSYN application PHP-FPM**
configuration, without putting any secret into Git, a .env file in public_html,
or the browser:

~~~text
QSYN_CONTROL_ENABLED=1
QSYN_SERVICE_MANAGER=direct
QSYN_ADMIN_PASSWORD_HASH=<PHP password_hash() of a strong dedicated administrator password>
~~~

The binary path is **not customizable from a browser request** and is hardcoded
relative to the deployed private Rust control adapter. Do NOT configure the
Supervisor variables when choosing direct mode. The environment variable
\`QSYN_ALLOW_HTTP_TEST\` is CI-only and MUST NOT be set on Cloudways.

Cloudways must permit at minimum the PHP functions \`proc_open\`,
\`proc_close\`, \`proc_get_status\` and \`proc_terminate\` for this application.
Do **not** enable \`system\`, \`exec\`, \`shell_exec\`, \`passthru\` or broad
PHP execution capabilities. Restrict /qsyn/admin/rust with a Cloudways WAF
or IP allowlist in addition to QSYN administrator authentication, and confirm
the entire QSYN runtime is isolated from QNEXT.

The application user must have permission to execute the Rust ELF binary and
write to the non-public \`private_html/qsyn/runtime/\` directory. Cloudways
must confirm that a detached child is allowed to survive the PHP-FPM request.
Deploying alone does not enable this mode.

### Behavior, limitations and acceptance tests

The Rust process is a self-detached app, NOT a full supervisor:

1. After admin login, click **Start** and then **Test Rust health**;
   expect HTTP 200 from the private /health endpoint.
2. Click **Restart**; validate the private Rust service responds again.
3. Click **Stop**; validate it becomes offline.
4. Verify 20-minute session expiration, invalid CSRF denial, invalid action
   rejection, and no ability to affect other processes.
5. If Cloudways kills the detached child, direct mode cannot fix the host-level
   restriction; use a provider-approved process manager or isolated worker.

**Direct mode does not auto-restart a crashed service or relaunch it after
a server reboot.** Arrange a host-approved scheduled health recovery/check
if those properties become necessary. Release upgrades may replace the binary
while an old process runs, so use a controlled restart after deployment.
The application has no live broker feed or trading capabilities in Phase 0.

Linux-only implementation: the direct Rust launcher uses setsid and /proc
identity verification. The CI and DigiOps release workflows exercise
start/stop/restart on disposable loopback ports, not Cloudways itself.

## Browser-based Rust WebSocket quote sampling

The QSYN chart and administration pages have a **Test demo stream** button.
It fetches a bounded PHP endpoint:
`GET /qsyn/api/v1/diagnostics/rust-stream`.

- The PHP bridge connects only to `127.0.0.1:10251/ws/demo`.
- It validates the WebSocket HTTP 101 response and Sec-WebSocket-Accept,
  then reads exactly two small server-to-client text frames.
- It returns only `QSYN-DEMO` quotes marked `simulated`, and rejects
  unexpected frames or payloads.
- `offline` means the Rust socket cannot be reached.
- `demo_disabled` means Rust is running but optional demo WebSockets
  were not enabled at service startup.
- `streaming` means two correctly labelled simulated quote events arrived.
- No browser WebSocket reverse proxy is needed for this one-shot test, and
  this endpoint is **not** a production market-data API.

The existing Cloudways `nohup` launch used no streaming environment flag,
so `demo_disabled` is the expected initial browser result. To test actual
quotes, Cloudways must **gracefully stop the existing verified QSYN process**
and start the Rust binary with environment variable
`QSYN_ENABLE_DEMO_WS=1`, retaining
`QSYN_BIND=127.0.0.1:10251`. For example, from the QSYN private directory,
after its existing process was stopped:

~~~bash
QSYN_BIND=127.0.0.1:10251 QSYN_ENABLE_DEMO_WS=1 nohup app/bin/qsyn-stream >> /absolute/private/tmp/qsyn-stream.log 2>&1 &
~~~

Replace the log path with the actual writable private Cloudways path; never
start a second instance while port 10251 is occupied. Keep `/ws/demo`
disabled on deployments where the simulated feed is not needed.

Once this is verified, the future product work is to implement an authenticated,
multi-account Upstox feed adapter and a licensed synthetic data pathway,
rather than using these simulated quotes as market data.

## No-console simulated WebSocket operations

The QSYN administrator panel at `/qsyn/admin/rust` now provides
**Enable demo stream** and **Disable demo stream** buttons in addition to
the existing Start, Stop, Restart and read-only tests. The buttons require
the same administrator login, CSRF token, HTTPS request validation and
secure session used for service management.

The new Rust executable checks the private persistent file
`private_html/qsyn/runtime/demo-websocket.flag` on each incoming demo
WebSocket handshake. Value `1` enables simulated quotes; `0` disables
them. The admin PHP API writes a randomized sibling file with mode 0600,
then atomically renames it. No shell, process restart, or public Rust
TCP port is needed to change the demo flag **once the new executable
is running**. The old `QSYN_ENABLE_DEMO_WS` environment variable
remains a fallback when the flag file does not exist.

**Initial activation is different from ongoing operation:**

1. Deploy the updated QSYN release in DigiOps. Its PHP admin page and Rust
   binary are published to disk, but the old `nohup` process keeps
   running the previous executable until separately restarted.
2. Arrange **one controlled transition** to the new Rust binary with
   Cloudways Support, confirming it is the QSYN process and leaving
   QNEXT untouched. The new runtime reports
   `demo_runtime_control=true` in `/health`.
3. Configure the administrator password hash and
   `QSYN_CONTROL_ENABLED=1` securely outside the website, using
   Cloudways-approved PHP-FPM configuration. The feature is deliberately
   *disabled by default* to prevent a public unauthenticated process
   controller.
4. Once authenticated in the admin page, use the Enable/Disable buttons.
   Changes take effect for **new** simulated WebSocket sessions without
   restarting Rust. Existing connections may continue transmitting until
   disconnected.
5. For browser Start/Stop/Restart, independently configure the provider
   approved restricted service-control mechanism such as
   `QSYN_SERVICE_MANAGER=direct` and the necessary PHP process functions.
   Existing unmanaged `nohup` PIDs cannot be safely stopped from the
   restricted direct controller.

The private runtime directory must be writable by PHP and readable by the
running Rust service. If Cloudways executes PHP and Rust as different users,
ask Support to arrange a private group/ACL; do not move the flag under
`public_html`, chmod it 0777, or enable arbitrary commands.

This only controls `QSYN-DEMO` synthetic test quotes, not live Upstox
market data, actual trading or QNEXT. The public diagnostics endpoint
remains read-only.

**Limit:** a fully browser-only **first bootstrap** is not safe without a
trusted administrator identity. An operator must first provision those
credentials through a secure provider interface; do not add a public
first-user setup endpoint. Cloudways PHP execution restrictions may still
require operator approval before web Start/Stop/Restart can work.

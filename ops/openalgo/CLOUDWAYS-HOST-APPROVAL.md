# QSYN / OpenAlgo — Cloudways Python service capability gate

**2026-10-10 · Host approval: NOT VERIFIED · No host changes performed.**

The native OpenAlgo source and compiled React UI are already in the separate GitHub Actions artifact `qsyn-openalgo-foundation`. Packaging success does **not** install or keep its Python Flask app running. The current DigiOps `digiops-release` is a different PHP/Rust website artifact; it must remain unchanged until the native UI has passed staging acceptance.

## What Cloudways confirms, and what it does not

Cloudways' documented one-click offerings include WordPress, Magento, Laravel and **custom PHP applications**. Cloudways Flexible supports application SSH access when configured. Neither documentation alone is approval for a privately supervised Python service, reverse-proxy rules, or non-PHP long-lived processes on this particular server.

Sources:
- Cloudways supported application matrix: https://support.cloudways.com/en/articles/5134108-which-web-applications-can-be-hosted-on-cloudways
- Cloudways SSH/SFTP access: https://support.cloudways.com/en/articles/5119485-guide-to-connecting-to-your-application-using-ssh-sftp
- Cloudways application SSH activation: https://support.cloudways.com/en/articles/5121251-how-to-enable-ssh-access-for-application-users

Never confuse `python3 --version` or an SSH login with *supported* 24/7 Python process management. Application-level access can be restricted and does not grant server administrator access.

## Safe, read-only application-user test

A Cloudways-authorized administrator can copy `ops/openalgo/host-readiness.sh` to a **private** directory on the approved staging host, review it, and run:

```sh
sh host-readiness.sh
```

It only reads OS, available Python runtime/modules, runtime identity, and presence of a process-manager executable. It runs no downloads, network requests, broker logins, daemon commands, `sudo`, service starts/stops, file writes, or secret/environment displays.

A successful exit code means the report was produced; **it is not host approval**. `host_approved=NO`, `http_tls_proxy=UNVERIFIED`, `websocket_upgrade=UNVERIFIED` and `reboot_recovery=UNVERIFIED` must remain unchanged by the script regardless of what it detects.

## Precise Cloudways support request (copy/paste)

**Subject:** QSYN staging — authorize isolated Python 3.12+ Flask + WSS service alongside PHP application

> We currently run our PHP application at https://stage.digiti.in/qsyn/. We want to run the unmodified OpenAlgo Python Flask/React application as a *separate, private, persistently supervised service*, without replacing or interrupting existing DigiOps PHP/Rust deployment. Please confirm in writing for this Cloudways Flexible server:
>
> 1. Is Python 3.12+ with `venv`, `ssl`, `sqlite3`, native build dependencies and a private writable application directory allowed for an independent Python/Flask app under a non-root service UID? If you do not support Python services on this plan, please state this explicitly.
> 2. Will you **authorize and configure** a managed, always-on Python process, with bounded restart after process crash, SSH logout, application release, and server reboot? Which exact mechanism and delegated privileges are approved (restricted Supervisor or equivalent)? We do not request general root or arbitrary service-control permissions for PHP.
> 3. Can your TLS reverse proxy map a *separate approved staging hostname at web root* to loopback Flask HTTP (`127.0.0.1:5000`) plus OpenAlgo's authenticated WSS (`127.0.0.1:8765`) with correct WebSocket upgrade/idle timeout and `/socket.io` behavior? Upstream React's BrowserRouter currently requires root-relative paths. We will **not** expose raw backend ports.
> 4. Can native SQLite/DuckDB records, read-only source/assets, credential files (0600), log files and separate service configuration be maintained in private storage **outside public_html** and outside overwritten deployment artifacts? What survives deploy/reboot, and what backup/restore is offered?
> 5. Please confirm outbound HTTPS/WebSocket access permitted to approved broker APIs and DNS/TLS, while preserving loopback-only ZMQ (`127.0.0.1:5555`), least-privilege isolation and separate account-specific data. We will not activate broker tokens, market distribution or live orders before independent approvals.
> 6. If any requirement is unsupported, can you permit an independent Python host behind a QSYN-controlled TLS/DNS origin while Cloudways continues serving PHP? Please supply the exact restriction, not an assumption.
>
> We can share a non-sensitive read-only capability report and a process/proxy acceptance checklist. We cannot share credentials, API keys or user accounts in the ticket.

## Acceptance matrix — sign off each item with independent evidence

| Gate | Required evidence | Current |
| --- | --- | --- |
| G1 runtime | Non-root, Python >=3.12, virtualenv, SSL, SQLite and required native dependencies from authorized account | Unverified |
| G2 background processes | Provider-authorized supervisor, crash/logout/reboot recovery, bounded CPU/RAM/logs | Unverified |
| G3 private state | Owner-only writable private paths, 0600 secrets, database backup/recovery isolated from DigiOps | Unverified |
| G4 proxy/TLS | Dedicated root-origin React routes/deep links, Flask, WSS upgrades, Socket.IO and strict origin/CSRF/cookie behavior | Unverified |
| G5 isolation | Flask/WS/ZMQ ports not exposed publicly, test users cannot access private feeds, no cross-account scope | Unverified |
| G6 UI smoke | Upstream login/setup, dashboard, `/trading`, indicators/drawings, `/tools`, mobile, browser refresh all work | Unverified |
| G7 data/execution | Separate broker OAuth, verified feed/display/retention permissions, production risk; live trading disabled meanwhile | Unverified |

**Go/no-go:** If G1–G5 cannot be approved on Cloudways, deploy Python OpenAlgo on a separately administered host/VPS. Keep PHP/DigiOps on Cloudways; use dedicated TLS origin/proxy to connect the frontend safely. Do not try to convert a periodically invoked PHP page, cron entry, or `nohup` loop into a production supervisor.

**Further work only after hosting sign-off:** Deploy the existing full source artifact to the separate private host, create upstream-native venv/dependency store, configure supervised Flask/WS, verify root-origin React UI, then integrate QSYN Synthetic Studio and consider public homepage routing. Retain rollback throughout.

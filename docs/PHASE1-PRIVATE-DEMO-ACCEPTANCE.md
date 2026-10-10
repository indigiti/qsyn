# QSYN Phase 1.10 — Restricted mock-account dashboard trial

**Status: engineering and test preparation, not approval to enable accounts.**
The operator has verified that public PHP and Rust diagnostics are healthy,
two synthetic WebSocket quotes stream successfully and the public account
routes return 503/503/404. The running Rust SHA has been reported as
`dd5a1568b3d288ca045d42ca6d084137da18e68a`. Earlier deployment
labels #78 and #82 require independent release-history reconciliation.

## Mandatory external ingress prerequisite

Before any user-facing feature is enabled, infrastructure must provide
a **separate, non-public HTTPS deployment** with isolated private storage
and VPN or IP allowlist **at the ingress before PHP**. Do not turn on
account features at `stage.digiti.in`. The separate environment must
pass actual *inside* and *outside* anonymous two-network checks in
`docs/PHASE1-PRIVATE-INGRESS-RUNBOOK.md`. Evidence receipts are not
independent proof of vantage authenticity; infrastructure must review
actual source networks and ingress logs. No such approval is assumed here.

## Private PHP configuration and bootstrap

Only in the separate, access-controlled application environment, configure:

- `QSYN_ENV=development`
- `QSYN_PRIVATE_STAGING_CONFIRMED=1` — an operator assertion, not proof of VPN
- `QSYN_IDENTITY_ALLOWED_HOST=` the exact private HTTPS host
- `QSYN_IDENTITY_STORAGE_DIR=` an existing outside-webroot mode-0700 directory
- `QSYN_PRIVATE_PUBLIC_DOCROOT=` that application's existing public directory
- `QSYN_FIXTURE_BOOTSTRAP_ENABLED=1` only for temporary CLI fixture work

Identity, accounts and dashboard must remain **off until ingress testing
is independently approved**. For a controlled mock-only acceptance
window on the private deployment, explicitly enable
`QSYN_IDENTITY_ENABLED=1`, `QSYN_MOCK_ACCOUNTS_ENABLED=1` and
`QSYN_DASHBOARD_ENABLED=1`. Never enable them on the public hostname.
No real broker credentials, OAuth or order execution.

The artifact includes a CLI tool only in
`private/app/tools/private-demo-fixtures.php`; it has no HTTP route.
It rejects webroot storage, group/world-readable fixture roots,
unapproved hostname/environment, missing bootstrap opt-in, duplicate
identities, weak passwords, and interactive TTY password echo.

Seed three synthetic test users using a local non-echoing shell prompt;
do not paste test passwords into terminal command arguments, history,
GitHub CI logs or environment variables. Example for one user, from the
private deployment directory with approved environment already loaded:

```bash
read -r -s -p 'Test-only password for tenant-one alice: ' fixture_pw; echo
printf '%s\n' "$fixture_pw" |
  php private/app/tools/private-demo-fixtures.php \
  seed tenant-one alice member --with-mock-accounts
unset fixture_pw
```

Repeat with `tenant-one bob viewer` (without account flag) and
`tenant-two alice member --with-mock-accounts`, using **distinct**
test-only passwords. The member receives Upstox A, Upstox B and Dhan
simulation records. The viewer gets no linked accounts. All linked
records carry `execution_allowed=false` and simulated-only entitlements.

## Private acceptance checklist

After separate private-host ingress approval and temporary enablement:

1. Log in as tenant-one Alice on the private site; link/view three
   mock accounts, select Upstox A and confirm simulated candles.
   Select Upstox B and verify different synthetic candles.
2. Save Upstox A workspace theme light, 60 visible bars, focus layout.
   Reload/sign out/sign in; confirm settings restore for A but not B.
3. In separate browser contexts, verify tenant-one viewer Bob cannot
   see Alice's records or mutate them, and tenant-two Alice cannot
   view tenant-one source IDs, candles or workspaces.
4. Verify CSRF/Origin denials, stale-revision conflict and disconnected
   account chart revocation; verify the private mock audit log:
   `php private/app/tools/verify-mock-audit.php <private-root>`.
   HMAC alone cannot detect audit deletion or a compromised key.
5. While Alice remains logged in, revoke her fixture and verify the next
   account API request fails HTTP 401:

```bash
php private/app/tools/private-demo-fixtures.php revoke tenant-one alice
```

Revoke all remaining fixtures after testing. Repeated revocation fails
rather than resetting the record. Do not store any real API keys.

## Return to safe default

Disable `QSYN_FIXTURE_BOOTSTRAP_ENABLED` and all three account flags in
the **private environment** immediately after the approved time-boxed
acceptance window; recheck private login/accounts/dashboard routes are
inaccessible. Do not restart public Rust, change Supervisor or publish
port 10251. Reversion of the private deployment is a distinct
infrastructure responsibility, not a proven binary rollback.

**Completion requires** green QSYN CI and artifact verification, true
private ingress isolation from two independently checked networks,
operator authorization, successful mock-account UI/session acceptance,
audit checks and confirmed disablement after testing. Source work and
localhost CI alone do not fulfill private-host acceptance.

# QSYN Phase 1.11 — Separate Cloudways private application preflight

**Scope:** local structure and safe-default checks only. Nothing in this
milestone provisions Cloudways, changes Supervisor, deploys to staging,
sets up a VPN, signs off penetration testing, or enables broker access.

## Baseline to preserve

The operator verified PHP 200, Rust stream status `online`, two
simulated `QSYN-DEMO` WebSocket quotes, and public mock account
endpoints HTTP 503/503/404. The observed running Rust SHA was
`dd5a1568b3d288ca045d42ca6d084137da18e68a`.
These were *observations*, not proof of an artifact-to-deployment mapping.
Do not touch the healthy public `qsyn-stream`, its Supervisor unit,
or its loopback port `127.0.0.1:10251`.

## Cloudways application design

- Create **a distinct Cloudways application or cloned staging
  application**, not merely an additional domain alias on the same
  public app. Separate application root, PHP worker scope, document
  root and private fixture storage are mandatory.
- Cloudways staging copies may inherit the source application's
  credentials or settings. Inspect and rotate any cloned administrative
  credentials *through approved secure channels*; never put them into
  QSYN fixtures, GitHub, or chat.
- Protect the private application at the **edge before PHP**, e.g. an
  independently verified VPN or specific-source-IP ingress ACL.
  Cloudways staging's default password protection is useful as an
  additional control, but **not equivalent to network isolation**.
- Use an independently restricted exact HTTPS host, different from
  `stage.digiti.in`. Changing DNS or adding a domain alias to the
  existing public application does not isolate users or storage.
- Keep all of `QSYN_IDENTITY_ENABLED`,
  `QSYN_MOCK_ACCOUNTS_ENABLED`, `QSYN_DASHBOARD_ENABLED`,
  and `QSYN_FIXTURE_BOOTSTRAP_ENABLED` **off** while provisioning.
- Keep the private test app's Rust service demo-only; do not create
  another listener or share real broker tokens.

Cloudways platform references:
- https://support.cloudways.com/en/articles/5124886-how-to-create-a-staging-environment
- https://support.cloudways.com/en/articles/5128812-difference-between-primary-domain-and-additional-domains
- https://support.cloudways.com/en/articles/5120743-difference-between-master-and-application-credentials

## 1. Read-only, local public-default check

From a checkout/release whose `private/app/tools` includes the
preflight, run **under the target PHP configuration**:

```sh
php private/app/tools/private-deployment-preflight.php public-disabled
```

This confirms four environment switches are unset/0 in the **current CLI
process**. It cannot inspect another PHP-FPM pool's active environment.
An independent HTTP check on public `stage.digiti.in` must still return
503/503/404 for the mock identity, account list and dashboard,
and Rust must report both trading and real Upstox connection disabled.

## 2. Collect the private application's actual paths

The operator, not the application, supplies all of the following **full
existing canonical directories** to the offline CLI environment.

| Environment variable | Operator-supplied value |
| --- | --- |
| `QSYN_PUBLIC_STAGING_APP_ROOT` | Existing public QSYN application directory |
| `QSYN_PUBLIC_STAGING_DOCROOT` | Existing public QSYN document root inside public app |
| `QSYN_PRIVATE_APP_ROOT` | New separate private application directory |
| `QSYN_PRIVATE_PUBLIC_DOCROOT` | New private app's web document root inside its app |
| `QSYN_IDENTITY_STORAGE_DIR` | Owner-only (0700) private store **outside both sites' webroots and outside the public app** |
| `QSYN_IDENTITY_ALLOWED_HOST` | Exact private HTTPS host, never `stage.digiti.in` |
| `QSYN_ENV` | `development` |

These path assertions are intentionally more restrictive than a
domain alias. The preflight rejects overlapping application roots,
webroots outside their application, storage inside public roots, a
world/group-accessible fixture store, top-level symlink paths,
missing directories and public target hostnames.

Example invocation **after setting real values through a secure
operator-controlled environment mechanism**; do not put actual secrets
or credentials in a command line:

```sh
php private/app/tools/private-deployment-preflight.php private-preparation
```

It prints only **PASS/FAIL reason codes**, not private paths. **PASS means
the CLI structural prerequisites and disabled flags are valid; it is
not an authorization to enable users or proof of network isolation.**

Important: the tool checks its own CLI process, **not** the environment
of the public or private PHP-FPM worker. Cloudways must verify that
the exact app/worker has the intended flags, outside-webroot storage
and access scope by independent inspection.

## 3. Independent private-host network acceptance

Only once the separate app exists and the infrastructure team has
provisioned the ingress ACL/VPN, use the existing probes described in
`docs/PHASE1-PRIVATE-INGRESS-RUNBOOK.md`:

1. **Inside an authorized network:** test the private HTTPS host's
   unauthenticated mock login shell, Secure/HttpOnly/SameSite cookie
   protections, simulated dashboard, and 401 anonymous account/bars.
2. **Outside from a truly separate denied network:** require edge 401/403
   or refused/blocked connectivity for private health, auth and UI.
   A 404-only response or an ordinary DNS error does not prove ACLs.
3. Review the paired receipts with
   `VerifyPrivateIngressEvidence.py`. Infrastructure independently
   authenticates the source addresses/VPN identities and confirms
   ingress logs. The receipts alone cannot grant approval.

The existing inside probe needs mock features enabled to see the
private login shell. **Do not set these flags until the network ACL
has independently been verified first by direct infrastructure controls
and outside-network denial tests.** The final two-sided probes are
post-configuration confirmation, not the authorization to open access.

## 4. Approved test window and safe closure

Only after infrastructure approval, a separate deployment backup/
rollback plan and actual private ingress verification, the operator
may enable the mock-only flags in the **private app**, seed synthetic
users with the offline tool, and run Phase 1.10 browser acceptance.
See `docs/PHASE1-PRIVATE-DEMO-ACCEPTANCE.md`.

At test completion, first disable the three private app identity/account/
dashboard flags and fixture-bootstrap flag, verify network/account
denial, revoke test users and retain sensitive test audit files only
under an approved retention policy. Ensure public QSYN still streams
demo WebSocket quotes, with live trading and Upstox disabled.

**Rollback gate:** a DigiOps release artifact is not a verified
rollback. Private application file snapshot, environment configuration,
rollback action and post-rollback health checks require explicit
infrastructure rehearsals; never automatically roll back public #82
Rust solely because the private trial fails.

## Exit criteria

- Private *separate application* created with own app root/document root
- Offline preflight PASS from the intended CLI environment
- Public site flags disabled, with independent HTTP negative probes
- Operator-validated actual PHP-FPM environment and source-IP ACL/VPN
- Real inside/outside network acceptance receipts reviewed by operator
- Private test user, chart/account/session and audit acceptance successful
- Disabled state restored and independently verified

Only the **preflight implementation and its isolated CI tests** are
delivered by this PR; the actual infrastructure and acceptance gates
remain pending until configured and externally verified.

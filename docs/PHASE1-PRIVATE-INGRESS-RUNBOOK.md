# QSYN Phase 1.8 — Private ingress acceptance

**Environment status, 10 October 2026:** Operator reports QSYN Release
**#78**, artifact \`11659907559\`, commit
\`ccc92c161f5c5d6d45e02808cffabb40b7181bc4\` deployed to
\`https://stage.digiti.in/qsyn/\`. The GitHub artifact passed CI.
The public server's active Rust SHA and externally observed account
feature-denial checks remain **unverified by this project**.

Do not enable test identities, account API or dashboard on public
\`stage.digiti.in\`. Never enable real Upstox or trading in this phase.
This milestone implements **tests and evidence collection**, not ingress
configuration, Cloudways deployment, VPN/firewall setup, penetration
testing, or production security approval.

## Required infrastructure before the private tests

An operator must independently provide a **different, private** HTTPS
hostname (for example a privately routed domain), protected by a VPN
or ingress IP ACL **before PHP**. Cloudways must not simply use the
public hostname with a hidden link or a PHP-only "private" flag.

Use an isolated test deployment/storage environment, test identities
only, with the existing strict QSYN development switches, and ensure
the three user-facing features remain **off on the public host**.
No test password, session cookie, private key or broker credential may
be put into GitHub, commands, logs or these evidence files.

## Two separate networks: anonymous evidence only

The host used below is a **placeholder**. Replace it with the exact
operator-provisioned private HTTPS URL. The probe makes anonymous
**GET requests only**, never logs in or changes server configuration.

On a device **inside** the allowlisted/VPN network, run:

\`\`\`sh
python3 apps/web-php/tests/PrivateIngressProbe.py \
  --url https://PRIVATE-QSYN-HOST/qsyn \
  --side inside \
  --vantage private-vpn-client \
  --output qsyn-inside-evidence.json
\`\`\`

It requires private QSYN health to be 200, mock authentication
\`state\` to be an *unauthenticated* simulated login shell with a
secure cookie, the simulated dashboard shell with CSP, and anonymous
accounts and candles to remain 401.

On a **separate device and network outside** the allowlist/VPN, run:

\`\`\`sh
python3 apps/web-php/tests/PrivateIngressProbe.py \
  --url https://PRIVATE-QSYN-HOST/qsyn \
  --side outside \
  --vantage external-denied-client \
  --output qsyn-outside-evidence.json
\`\`\`

It requires the **health endpoint, dashboard and mock identity shell**
all to be blocked at ingress (HTTP 401/403) or by a refused/timed-out
connection. HTTP 404 (which could merely mean the app route is off),
redirects, HTTP 200, and DNS errors are **not accepted as proof** that
network ingress is restricted.

Copy **only the two generated evidence JSON files** into a trusted
review environment and check consistency:

\`\`\`sh
python3 apps/web-php/tests/VerifyPrivateIngressEvidence.py \
  --inside qsyn-inside-evidence.json \
  --outside qsyn-outside-evidence.json
\`\`\`

The verifier rejects mismatched target fingerprints, repeated vantage
labels, observations older than 24 hours, missing checks or incomplete
blocks. It marks \`private_access_approval=false\` even when receipts
are consistent: the source-network labels are **self-reported**.
An infrastructure operator must separately verify the actual source
public IP/VPN identity, ACL rules, ingress logs, TLS deployment, and
private storage isolation, then formally accept or reject the site.

### CI and rollout gates

The CI test \`PrivateIngressProbeTest.py\` uses *only* temporary
localhost PHP and a fake denied gateway. It verifies the acceptance
logic but **cannot** demonstrate that Cloudways VPN/ACLs work.

The previously added **QSYN Public Staging Read-Only Acceptance**
workflow should also be run against the operator-reported #78 SHA to
ensure the public staging site still denies all Phase 1 user routes
and disables real broker/trading capabilities.

**Do not proceed with enabling test accounts until the actual public
read-only check and the independently reviewed two-network private
acceptance have both passed.** Any future separate deployment needs its
own release/activation verification and recoverable rollback plan.

## Phase 1.9 — One-time public release verification

The GitHub workflow `.github/workflows/public-stage-acceptance.yml`
triggers a **read-only external public acceptance run** once when its
workflow change is merged to `main`. The automatic run expects the
last operator-reported deployed #78 Rust commit,
`ccc92c161f5c5d6d45e02808cffabb40b7181bc4`.

The workflow sends anonymous GET requests only to the QSYN public
health/demo/diagnostics endpoints and checks that public test identity,
mock accounts, and dashboard remain denied. It does **not** deploy
an artifact, enable identity flags, or change Cloudways.

A failed run must not be interpreted automatically as a vulnerable host:
DNS/network unavailability, a stale reported deployment SHA, or an API
contract difference could also cause failure. Review the job's actual
checks. A green result establishes only the specific public checks
performed from that runner, not VPN or private-ingress attestation.

If a later release is deployed, operators must use the workflow's
manual `workflow_dispatch` input with the **new exact deployed SHA**;
they must not reuse #78 when its binary is no longer running.

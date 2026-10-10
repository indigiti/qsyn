# QSYN Phase 1.6 — Private Security Gate and Staging Acceptance

**Status:** source + CI validation only. QSYN Cloudways staging stays on the
verified #58 runtime. Do **not** deploy or switch on the Phase 1 test-user
login, mock broker accounts or dashboard at \`stage.digiti.in\`. There is no
real Upstox session, market-feed entitlement or trading permission.

## Threat boundary and safeguards

1. The PHP fixture identity API requires \`QSYN_IDENTITY_ENABLED=1\`,
   \`QSYN_ENV=test|development\`, an existing absolute storage directory
   outside the document root, and owner-restricted file permissions.
   The fixture API and chart dashboard default to **off**.
2. Test HTTP is allowed only when \`QSYN_ENV=test\`,
   \`QSYN_ALLOW_HTTP_TEST=1\` **and** both the PHP listener
   \`SERVER_ADDR\` and client \`REMOTE_ADDR\` are \`127.0.0.1\`,
   with a loopback Host header. A public connection with a spoofed
   localhost Host header cannot use the test-only insecure cookie path.
3. For an independently isolated development host, require **all**
   of \`QSYN_ENV=development\`,
   \`QSYN_PRIVATE_STAGING_CONFIRMED=1\`, and the exact HTTPS host in
   \`QSYN_IDENTITY_ALLOWED_HOST\` (including a nonstandard port).
   The PHP host check is an **additional safeguard, not proof of an
   ingress firewall**. A VPN or ingress IP allowlist must be deployed,
   tested from *outside* the allowed network and separately approved
   before any test users are enabled. Do not set this confirmation flag
   just to make staging work.
4. \`QSYN_MOCK_ACCOUNTS_ENABLED=1\` is a separate API opt-in and
   \`QSYN_DASHBOARD_ENABLED=1\` is a third, separate UI opt-in. Both
   rely on the same private identity/transport gate. There is no
   self-signup, real OAuth, trading or market-feed integration.
5. File-backed test identities, mock accounts, chart workspaces and
   audit records reject symlink paths, world access, group-writeable
   private directories, and world/group readable record files.
   They are **not** approved for production financial data.

## Private mock-audit integrity

Every new mock event is stamped with an HMAC-SHA256 derived from a
random 256-bit key generated once per private directory in
\`mock-audit-hmac.key\` (mode 0600). The key is NEVER included in a
DigiOps artifact, HTTP response or GitHub logs. Offline CLI usage
from a developer checkout:

\`\`\`sh
php apps/web-php/tools/verify-mock-audit.php /absolute/private/mock-store
\`\`\`

A nonzero exit indicates missing signing material, an unsealed legacy
record, wrong file permissions, or a changed event payload. This
detects file-content corruption/edits **only while the signing key
remains trusted**. It does NOT detect event-file deletion, key
replacement, root compromise, or guarantee an immutable chronological
ledger. There is no HTTP audit viewer. Event storage is suitable only
for disposable development fixtures, not regulatory audit compliance.

## Read-only acceptance sequence (no rollout authorized)

1. **Baseline:** keep #58 healthy. Do not change Supervisor, Rust listener,
   Cloudways permissions, public routes or any of the three flags.
2. **Source/CI:** ensure PHP unit/HTTP tests, Chromium role isolation and
   chart painting, Rust tests, and DigiOps artifact integrity all pass
   for the same reviewed main commit.
3. **Environment gate:** run the read-only CLI preflight **under the same
   PHP environment as the target worker**:
   \`php apps/web-php/tools/phase1-stage-preflight.php\`.
   A pass means all three Phase 1 enablement flags are off; it does not
   prove network isolation. CI also verifies the script fails when a
   flag is on.
4. **Public negative tests:** independently verify that the normal
   publicly reachable site has *no active mock login, broker account
   API or private workspace*. Confirm public responses carry no
   file paths, secrets or private identity data, including when the
   Host header is changed.
5. **Separate private acceptance host (later, after operator approval):**
   provision a new non-public HTTPS hostname behind independently
   tested VPN or IP ACL. Configure the exact allowed host and private
   storage outside webroot. Load only synthetic test identities. Exercise
   login/logout, session expiry, CSRF, owner/tenant denial, audit
   verification, workspace restoration, and safe revocation.
6. **Recovery:** disable the three Phase 1 flags first if acceptance
   reveals a problem. Preserve baseline #58. Historical DigiOps
   rollback remains a separate unverified operational check.

The CI green status and local Chromium tests do not constitute
production approval, penetration testing, compliance certification
or an actual Cloudways staging security assessment.

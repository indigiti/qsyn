# QSYN Phase 1.12 — Private pre-activation deployment acceptance

**Engineering preparation, NOT Cloudways approval.** Phase 1.11 CI and package passed; the previous GitHub public stage acceptance observed HTTP 403 HTML on \`https://stage.digiti.in/qsyn/api/v1/health\`. This can be edge protection or routing, not necessarily an application defect. Never disable Cloudways protection merely to make public CI green.

## Safety invariants

- Leave the existing public application, Supervisor, 127.0.0.1:10251 and Rust demo stream untouched.
- All four QSYN identity, mock-accounts, dashboard and fixture-bootstrap flags remain **off** in **both** applications throughout pre-activation.
- Real trading and Upstox remain disabled; do not enter any broker credentials.
- Private hosting must use a distinct Cloudways application, real directory and worker isolation, owner-only external webroot storage, a dedicated HTTPS hostname and **edge-level** VPN/IP ACL. A domain alias or password-only staging is insufficient.
- The CLI preflight only checks its process, not PHP-FPM. A green GitHub build is not a deployed or network-security acceptance result.

## Operator sequence (no account enablement)

1. Infrastructure provisions the separate application and takes an application backup. Independently establish source-IP/VPN allowlist and exact host routing **before deploying mock-enabled content**. Review TLS, server access logs, PHP-FPM pool/environment and directory ownership with Cloudways.
2. Install the verified DigiOps payload into the **private application only**; do not overwrite existing public application or Supervisor. Compare deployed release manifest against the intended release artifact and check demo/trading flags using the private host.
3. With the four flags still **off**, run in the intended **private app CLI environment**:

   \`\`\`sh
   php private/app/tools/private-deployment-preflight.php private-preparation
   \`\`\`

4. From a physically/logically authorized network, capture an anonymous disabled-feature baseline. Substitute the actual private HTTPS origin and an innocuous vantage label (not credentials):

   \`\`\`sh
   python3 apps/web-php/tests/PrivateBaselineProbe.py probe \
     --url https://PRIVATE-QSYN-HOST/qsyn --side inside \
     --vantage vpn-client --output inside-baseline.json
   \`\`\`

   This requires health HTTP 200, simulation bars, Rust diagnostic denying real connectivity when online, and auth/account/dashboard routes denied without a user session. An offline Rust status is recorded, **not treated as proof that a deployed runtime is safe**; validate it independently.

5. From a **separate, independently restricted** network, capture:

   \`\`\`sh
   python3 apps/web-php/tests/PrivateBaselineProbe.py probe \
     --url https://PRIVATE-QSYN-HOST/qsyn --side outside \
     --vantage denied-mobile --output outside-baseline.json
   \`\`\`

   All health/auth/dashboard requests must fail with 401/403 **at ingress** or be transport-blocked. The script cannot tell an edge denial from a PHP-generated 403; validate denial source using edge logs. 404, redirects, DNS failures and HTTP 200 are **not** acceptable outside evidence.

6. Review the two receipts offline:

   \`\`\`sh
   python3 apps/web-php/tests/PrivateBaselineProbe.py verify \
     --inside inside-baseline.json --outside outside-baseline.json
   \`\`\`

   The verifier requires matching exact-target SHA-256 fingerprints, separate labels, receipts younger than 24 hours and all required observations. It deliberately prints \`private_access_approval=false\` and \`enable_accounts=false\` even after consistency passes.

7. Infrastructure attests **actual** source addresses, firewall/VPN rules and ingress logs, PHP-FPM effective flags, separate roots/storage, rollback, and public disabled-feature behavior. Store records outside GitHub. Do **not** put test credentials, cookies, CSRF tokens or sensitive network details in receipts.

## Post-approval Phase 1.10 testing

Only an explicitly approved test window permits temporarily enabling synthetic mock identity/account/dashboard features on the isolated private app. Run the **existing** \`PrivateIngressProbe.py\` enabled-shell two-network confirmation, browser/role/tenant/audit tests, and fixture revocation; then switch all flags off and verify denial from both networks. This Phase 1.12 change **never** enables accounts.

## Remaining external blockers

Cloudways separate-app provisioning, VPN/IP restriction and log attestation, public 403 diagnosis, PHP-FPM environment validation, real-world two-sided receipts, restore/rollback rehearsal and operator sign-off. No GitHub CI result removes these gates.

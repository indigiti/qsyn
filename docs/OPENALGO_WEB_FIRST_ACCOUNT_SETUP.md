# QSYN OpenAlgo Web Account Setup — First Connection

## Why QSYN showed "Not provisioned" / 503

The public broker catalog only contains the 36 available OpenAlgo plugin names. The original operator API expected existing private files (openalgo-registry.json, login mapping and app API key). With no registry, GET /qsyn/api/v1/admin/openalgo/accounts returned 503, and the React Broker Connections screen displayed "Not provisioned".

The new endpoint returns **HTTP 200** for a genuinely missing registry, with configuration_state=not_provisioned, setup_available and the setup_mode. A malformed or insecure *existing* registry continues to fail closed (503). No silent creation of real broker sessions.

## Complete QSYN configuration in the browser

1. Use the existing QSYN Operations administrator password at /qsyn/terminal/operations. This is NOT the Upstox username/password.
2. Open /qsyn/terminal/brokers and choose Upstox.
3. If no private broker registry exists and QSYN's protected runtime is writable, the "Configure first OpenAlgo connection" form appears.
4. Fill out an **operator-defined QSYN account label**, **approved OpenAlgo native HTTPS /login URL**, **local OpenAlgo REST port**, **local WS port**, and the **OpenAlgo APPLICATION API key** from that instance (NOT the Upstox developer API key, API secret, OTP or OAuth token). Explicitly confirm you control the approved OpenAlgo host.
5. Click **Save private connection profile**. The server creates one account's registry, approved login mapping and API-key file in the existing QSYN private runtime using owner-only 0600 permissions. All three files are created once; an existing profile is never silently overwritten. The UI never receives the key back.
6. The account now appears on the Brokers page. Click **Connect with OpenAlgo** to open that instance's login, complete its original Upstox OAuth callback there, then select **Verify session** in QSYN. A read-only ping checks only the expected OpenAlgo broker plugin and whether the service responds.

**Prerequisite:** The native Python OpenAlgo service, private loopback listener, managed restart and HTTPS root-origin login still require prior approval and installation by Cloudways (or another approved Python host). The web form **cannot install the service, obtain real provider credentials or authorize Upstox**. If the instance is not running, Verify session shows unavailable/expired.

**Security:** HTTPS + current QSYN administrator session, same-origin enforcement, CSRF and strict payload validation; no path, shell, arbitrary HTTP target, Upstox secret, order command or OAuth callback accepted. The app key is submitted by the administrator once over HTTPS and stored in a 0600 file, not echoed in responses. The fixed key directory is owner-only 0700. Existing private profiles and external registry paths are never replaced. An existing invalid registry remains a hard error.

This is **operator-only** onboarding, not automatic production tenant/user mapping. All auto-created accounts use the literal internal scope operator-private / qsyn-admin. A real customer/UCC and exchange data entitlement must be independently verified. QSYN trading remains disabled, but native OpenAlgo can expose order APIs and must be independently restricted before real credentials are used.

## Tests and fallback

The API's first-time status is 200 and no longer produces repeated 503 console errors. The CI smoke test exercises the complete web first-run state, invalid login URLs and ports, wrong CSRF/origin, replay protection, private 0600 files, sanitized fake Upstox ping, and logout. DigiOps packages the new class and verifies it in the downloaded artifact.

If the form says provisioning unavailable, check that the administrator session is active and Cloudways allows the PHP application to own/write the **private** QSYN runtime. If a registry already exists but is invalid, an approved operator must repair it using Cloudways private file management; the web form deliberately refuses to overwrite. Keep private credentials outside public_html and never share them in ChatGPT or in a GitHub issue.

# QSYN OpenAlgo Broker Selection — staged foundation

The new React Broker Connections workspace selects from OpenAlgo's 36 installed broker names.
The public `GET /qsyn/api/v1/brokers/openalgo/catalog` returns **names only**, never
a connected account. Privately scoped `accounts`, `connect` and `status`
are disabled by default and require:

- `QSYN_OPENALGO_BROWSER_CONNECT_ENABLED=1` **and** the existing private
  **test/development-only** QSYN identity gate, with HTTPS, approved private ingress,
  valid user session, and role checks.
- Existing `QSYN_OPENALGO_REGISTRY_FILE` 0600 loopback-instance registry
  (one account/session per isolated instance). Private entries must match the
  logged-in QSYN tenant and owner; browser cannot choose host, ports or tenant.
- Optional `QSYN_OPENALGO_LOGIN_URLS_FILE`, an independent 0600 private JSON:
  `{"schema":"QSYN-OPENALGO-LOGIN-URLS/1","accounts":[{"account_id":"upstox-a","login_url":"https://openalgo-a.example.com/login"}]}`.
  The HTTPS FQDN is **illustrative**, not a deployed login. Each operator-owned
  login target must actually point to the correct isolated OpenAlgo instance,
  enforce upstream user login, and have trusted TLS. No external untrusted host.
- `connect` validates same-origin JSON, current CSRF, member role, account scope and
  the private configured login before returning its URL. QSYN never exchanges
  a broker code or token via this browser API.
- `status` makes a short read-only OpenAlgo `/api/v1/ping` against the
  **server-pinned loopback port** using only the private app API key.
  A responding session does **not** verify broker UCC, market-data entitlement,
  license, refresh state, or order permissions. Trading stays disabled.

**Important:** This feature is for private development acceptance only.
The existing mock identity is not a production user login. Do NOT enable
this against public staging or claim that real Upstox OAuth is complete.
Broker login and service deployment require separate operator action.
The code deliberately introduces no live execution API, no secrets in
JavaScript, no homepage modifications, and no database.

Next gate: audited production identity, approved OpenAlgo tenancy and HTTPS
reverse proxy, exact provider UCC verification, real market-data rights,
read-only chart entitlement and browser acceptance on isolated ingress.

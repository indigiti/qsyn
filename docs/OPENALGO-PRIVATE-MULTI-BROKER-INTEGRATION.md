# QSYN Broker Authorization & OpenAlgo Feature Integration — Private Gateway

Status: source implementation. **Not live activation, not a public service**. QSYN's previously shipped OpenAlgo Charts/terminal UI remains byte-for-byte unchanged in this release. OpenAlgo's *full trading application UI* is maintained by the upstream `marketcalls/openalgo` project and should be run separately if the operator wants its Dashboard, Orderbook, Tradebook, Positions, Trading, Platforms, Strategies, Logs, Tools, Supertrend, Replay, Workspaces, One-Click and other original controls.

## Design and authoritative upstream contracts

This release integrates QSYN with existing OpenAlgo—not a second implementation of its 36 broker plugins, login forms or OMS:

- <https://github.com/marketcalls/openalgo/blob/main/docs/api/README.md> — OpenAlgo `/api/v1` REST routes and broker API key contract.
- <https://github.com/marketcalls/openalgo/blob/main/docs/api/utility-services/ping.md> — authenticated ping; invalid/expired OpenAlgo API key/session fails with HTTP 403.
- <https://github.com/marketcalls/openalgo/blob/main/docs/api/websocket-streaming/ltp.md> — `ws://127.0.0.1:8765`, `authenticate`, `subscribe` to LTP (mode 1).
- <https://github.com/marketcalls/openalgo/blob/main/docs/broker-integration-guide.md> — broker OAuth callback / TOTP patterns and plugin registration.

The upstream OpenAlgo application is responsible for collecting broker consent, storing active broker access tokens, broker feature support, session expiry/reconnect, broker-specific symbol masters, and actual order API implementation. QSYN does **not** accept OAuth callbacks, broker passwords, API secrets or TOTP from anonymous web requests. No new web route, customer login field, button or browser script was added.

## Newly implemented QSYN private components

1. **`PrivateBrokerRegistry.php`** loads an operator-supplied 0600 registry JSON outside webroot, validates owner permissions, and binds every broker to an independent localhost REST + WebSocket port and separate 0600 OpenAlgo *application* API key. Account/tenant/owner scope is enforced on each CLI command, not selected by an unauthenticated browser query string. A single OpenAlgo instance must never be used as a substitute for two independent Upstox A/B account sessions.
2. **`PrivateOpenAlgoReader.php`** supports authenticated, private REST calls to `ping`, `quotes`, `depth`, `history`, `optionchain`, `funds`, `holdings`, `positionbook`, `orderbook`, `tradebook`, `symbol`, `expiry`, `search`, `multiquotes`, `intervals`, and `analyzer` **read mode**. Although upstream uses POST for these read operations, only fixed endpoint names are allowlisted. QSYN rejects `placeorder`, `optionsorder`, `basketorder`, `cancelorder`, `strategy/start`, `analyzer/toggle` and **all unknown/mutating endpoints**. Most unknown output types return only counts or readiness, never raw broker account details. No generated responses are published on the internet.
3. **`private-broker-gateway.php`** is a CLI-only scoped inventory and read command. It requires the explicit opt-in flag `QSYN_PRIVATE_BROKER_GATEWAY=1`, rejects real trading flags, and cannot reach any URL supplied by a user or untrusted input: network addresses are forced to `127.0.0.1` and validated operator-selected ports.
4. **`openalgo_stream.rs`** authenticates a private local OpenAlgo WebSocket subscription and validates broker, exchange, subscribed symbol, LTP mode, timestamps, invalid/stale prices and duplicate frames. It does not assert regulatory/feed entitlement from a successful OpenAlgo login. It returns only coarse diagnostic counters, **never raw prices or credentials**.
5. **`qsyn-openalgo-feed`** is a separately invoked, bounded, operator-only live-feed probe using the same account registry and a separate `QSYN_PRIVATE_FEED_PROBE_ENABLED=1` switch. Maximum eight symbols, 100 observed valid ticks and eight seconds. It does not write market prices to QSYN's WAL, enable live subscription in public charts, or send a broker order.

Full OpenAlgo features remain available **inside a separately installed upstream OpenAlgo application** when the user signs into a supported broker. The adapter provides read-only QSYN integration, not a duplicate OpenAlgo terminal.

## Private operator setup (requires actual broker credentials and Cloudways operations)

This is **not** an instruction to set the flags in the public QSYN PHP app. Deploy a separate, ACL-restricted application with a privately installed OpenAlgo runtime and obtain appropriate account/market-data rights.

1. In each independently isolated OpenAlgo instance, choose its actual broker plugin (e.g. `upstox`, `zerodha`, `fyers`), complete **that broker's own current OAuth/TOTP/consent flow in the upstream OpenAlgo login UI**, and confirm read-only `/api/v1/ping` responds with the expected broker. Select a different OpenAlgo instance and port pair for each *distinct account*.
2. On the operator server, create a private 0700 directory **outside public webroot**. Place each account's OpenAlgo application API key in a different 0600 file. The keys must not be broker secret keys or OAuth refresh tokens. Protect and rotate the key files using supported OpenAlgo controls.
3. Create an owner-only 0600 config such as:

```json
{
  "schema": "QSYN-PRIVATE-OPENALGO-REGISTRY/1",
  "accounts": [
    {
      "account_id": "upstox-a",
      "tenant_id": "tenant-approved",
      "owner_user_id": "owner-approved",
      "broker": "upstox",
      "rest_port": 5000,
      "ws_port": 8765,
      "openalgo_apikey_file": "/ABSOLUTE/PRIVATE/keys/upstox-a-openalgo-key.txt"
    },
    {
      "account_id": "upstox-b",
      "tenant_id": "tenant-approved",
      "owner_user_id": "owner-approved",
      "broker": "upstox",
      "rest_port": 5001,
      "ws_port": 8766,
      "openalgo_apikey_file": "/ABSOLUTE/PRIVATE/keys/upstox-b-openalgo-key.txt"
    }
  ]
}
```

This is an example of structure, not a claim that the indicated ports or users exist or that credentials were previously configured. Each port must actually be bound to its approved loopback-only service in the same network namespace. No public OpenAlgo gateway/tunnel bypass.

4. From the restricted operator shell, **not** web requests or CI:

```sh
export QSYN_PRIVATE_BROKER_GATEWAY=1
export QSYN_OPENALGO_REGISTRY_FILE=/ABSOLUTE/PRIVATE/openalgo-registry.json
php private/app/tools/private-broker-gateway.php list tenant-approved owner-approved
php private/app/tools/private-broker-gateway.php read tenant-approved owner-approved upstox-a ping
php private/app/tools/private-broker-gateway.php read tenant-approved owner-approved upstox-a quote '{"symbol":"NIFTY29OCT2624500CE","exchange":"NFO"}'
# ONLY after verifying a valid current instrument from the broker:
export QSYN_PRIVATE_FEED_PROBE_ENABLED=1
private/app/bin/qsyn-openalgo-feed inspect tenant-approved owner-approved upstox-a NFO:NIFTY29OCT2624500CE
```

The `29OCT26` symbol is **illustrative**, not asserted as presently listed. Reject stale or unapproved subscriptions. Real broker sessions and feed permissions must be verified from the operator's account at the provider, not from test output.

## Acceptance / kill switches

The new code runs nowhere unless invoked from a private CLI with both required operator switches. `QSYN_TRADING_ENABLED=1` and `QSYN_ENABLE_LIVE_TRADING=1` are explicit stop conditions. There are no publicly accessible QSYN broker login or live feed routes. Connection success says only `broker_session_responding=true`; it does **not** establish exchange redistribution rights, complete subscription entitlements, or an approved trade workflow. If the upstream broker refuses authentication, the tools return a generic error and no account data.

CI simulates two separate fake upstream OpenAlgo servers and verifies account-scope isolation, 0600 registry and keys, unsupported operations, sanitized data, and fake WebSocket authentication+subscriptions. No production credentials are stored or accessed during CI. DigiOps packages only the tools and binary in `private/app`; never the registry or keys.

## Remaining genuine production gates

- Cloudways private app with verified ACL/VPN ingress and correct Unix/FPM credentials, plus real separately logged-in OpenAlgo processes. This is **not** implementable from source control alone.
- Account owner-specific browser authorization, data redistribution consent, server-side tenant entitlements, and secure private WSS chart feeds; the public QSYN Studio remains SIMULATED.
- Production continuous streaming workers, subscriptions/reconciliation/backfill, OI/Greeks validity and live synthetic timeline. The eight-second bounded probe is not such a worker.
- Durable paper trading OMS, order idempotency and state machine, broker sandbox test certification, margin/risk approval and staged live order-release workflow. These are not safely equivalent to a switch or a single local quote.
- Disaster recovery, capacity testing, regulatory/exchange retention licensing and monitored live operations.

**Use OpenAlgo's original UI for its full feature set. Do not remove or redesign it to accelerate QSYN integration.**

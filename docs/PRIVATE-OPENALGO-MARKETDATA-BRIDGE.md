# QSYN market-data bridge — first private provider integration

## What this release actually delivers

The current QSYN public Options Studio stays fully simulated, with no broker credentials, order API, or market-data redistribution.

This release introduces a **real OpenAlgo read-only API contract and operator-only loopback probe** that can interrogate an independently provisioned and authorized OpenAlgo instance for an option quote or a nearby option chain. It also adds a streaming offline Upstox BOD JSON/GZIP option-instrument catalog inspector. Neither tool starts a live streaming process nor provides public trading prices.

It additionally fixes the product limitations found in the #93 screenshots:
- Individual CE/PE charts now support **all four** legs; no longer only the first two.
- Gamma prints six decimal places (delta three) instead of rounding nonzero values to +0.00.
- Each replaced OpenAlgo widget is explicitly destroyed before replay/chart remount, releasing browser observers, canvas and listeners.

## Provider contract references

- OpenAlgo Quotes: https://docs.openalgo.in/api-documentation/v1/data-api/quotes
- OpenAlgo Option Chain: https://docs.openalgo.in/api-documentation/v1/data-api/option-chain
- Upstox BOD Instruments: https://upstox.com/developer/api-documentation/instruments/
- Upstox Market Feed V3: https://upstox.com/developer/api-documentation/v3/get-market-data-feed/

OpenAlgo quote API uses `POST /api/v1/quotes` with `apikey`, `symbol`, `exchange`. OpenAlgo option-chain API uses `POST /api/v1/optionchain`, `apikey`, `underlying`, `exchange=NSE_INDEX`, `expiry_date=DDMMMYY` and `strike_count`. Both are **private-provider POSTs performed only by the CLI adapter**, not exposed as QSYN HTTP routes. Upstox V3 is binary WebSocket/Protobuf, not a JSON stream; its authentication, entitlements and streaming transport remain unimplemented.

## Operator-only setup, NOT public-stage enablement

Only after authorized broker credentials and approved **separate private** OpenAlgo deployment:

1. Verify network separation, service account, broker market-data entitlement, real instrument map and licensed intended use. OpenAlgo must listen on `127.0.0.1:5000` in the appropriate isolated network namespace (or a separate manually verified loopback port); do **not** expose the OpenAlgo backend to the internet or forward private credentials to PHP browser pages.
2. In the **private** QSYN application (not public staging), create a private key file **outside webroot**, owner-matched to the invoking CLI Unix process and mode **0600**. Never commit or package the key. Use the exact destination-specific path.
3. With all order-execution and public mock-account features still off, explicitly opt into a **single read-only probe** in the CLI environment:

   ```sh
   export QSYN_MARKETDATA_PROBE_ENABLED=1
   export QSYN_OPENALGO_APIKEY_FILE=/ABSOLUTE_PRIVATE_RUNTIME/openalgo-key.txt
   export QSYN_OPENALGO_LOOPBACK_PORT=5000
   php private/app/tools/openalgo-local-probe.php quote NIFTY29OCT2624500CE NFO
   php private/app/tools/openalgo-local-probe.php chain NIFTY 29OCT26
   ```

   The symbol and expiry above are illustrative query formatting, **not proof that a contract exists or is current**. Use valid contracts from the current instrument master. If private OpenAlgo is on a different server, a loopback-only adapter cannot reach it and should **not** be bypassed with an unverified public endpoint.

4. Probe results deliberately say `freshness_verified=false`, `entitlement_verified=false`, `exchange_timestamp=null` and `publishable_to_public_studio=false`. A received LTP alone cannot establish the market timestamp, licensing, quote freshness, or subscription permission. These results are operator diagnostics, not live charts and **not trading signals**. There is no continuously running ingestor.

**Security:** The PHP adapter has a hardcoded `http://127.0.0.1` target, follows no redirects, accepts only vetted GET-equivalent provider read operations, and rejects requests unless the opt-in environment flag is set. Although the upstream OpenAlgo quotes and chain APIs use HTTP POST, this QSYN CLI never calls order endpoints. The secret must be in a 0600 owner-controlled file outside a web-accessible path. Responses are allowlist-sanitized; keys and arbitrary provider metadata are not re-emitted. It does not invoke Rust process controls or change trading state. Never set `QSYN_TRADING_ENABLED=1` for these diagnostics.

## Genuine options contract and expiry inspection (offline)

Use a locally supplied Upstox JSON or JSON.GZ BOD instruments file. Do not rely on deprecated CSV or fabricate expiries:

```sh
python3 private/app/tools/upstox-instrument-inspect.py \
  --file /ABSOLUTE_PRIVATE_INPUT/upstox-nse-instruments.json.gz \
  --underlying NIFTY
python3 private/app/tools/upstox-instrument-inspect.py \
  --file /ABSOLUTE_PRIVATE_INPUT/upstox-nse-instruments.json.gz \
  --underlying NIFTY --expiry 2026-10-29
```

The inspection streams JSON objects with bounded memory; accepts only `NSE_FO` CE/PE records with real `instrument_key`, `underlying_symbol`, ISO expiry, strike, lot size and trading symbol, and rejects inconsistent duplicate option identities. The date argument in this example is **illustrative**: the contract must be confirmed from a provider file obtained by the authorized operator. File freshness and entitlement are not attested; results say so. No automatic download, market-data upload or broker authorization is performed.

## CI and release gates

GitHub CI builds and runs:
- Local-fake OpenAlgo quote and option-chain acceptance with an owner-only key file; disabled probe, invalid symbol/exchange/expiry and world-readable-key failures.
- Plain JSON/GZIP Upstox catalog streaming, expiry and instrument-key selection, corruption and conflicting-contract rejection.
- Existing PHP, Rust, Chromium and release acceptance.
- Browser four-leg real canvas checks, model-Gamma display precision, replay widget lifecycle.
- DigiOps artifact contains the new provider class, private CLI and instrument inspector only under `private/app`, never includes credential file.

## Still required for actual live QSYN

Authorized Upstox OAuth/API token lifecycle, V3 Protobuf decoder and WebSocket connection/reconnect, per-user OpenAlgo contexts and source timestamp/freshness auditing, public chart permission model and market-data distribution rights, secure worker-to-Rust integration, durable replay/backfill. Public `/qsyn/studio` remains labeled SIMULATED. Trading remains disabled. None of these can be bypassed by turning on an environment variable or merely deploying this release.

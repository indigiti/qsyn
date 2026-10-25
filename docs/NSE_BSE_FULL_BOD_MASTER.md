# QSYN NSE/BSE Complete Instrument Masters

QSYN's **private, read-only** market explorer can browse the complete Upstox
Beginning-of-Day (BOD) NSE and BSE instrument JSON lists, including equities,
indices, futures, options and currency contracts. Catalog data is **not**
market data or trading entitlement. The existing seven index charts and
Rust WSS ingestion are unchanged.

Sources (fixed vendor URLs):
- NSE: https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
- BSE: https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz

Upstox refreshes BOD files around 06:00 IST. The source may change intraday.
The displayed import date reflects QSYN's ingestion time, **not** a provider
attestation or guarantee that a contract remains tradeable. Instrument keys are
preferred to reusable exchange tokens. Do not use stale keys to infer prices.

## Operator import

Requires Python 3.12+ **only when the operator refreshes**, not a resident
Python worker or runtime server. The script and shared streaming decoder are
both distributed in the DigiOps **private app tools** directory. It writes
atomic file snapshots under `$QSYN_RUNTIME_DIR/upstox-master/` (private
directory 0700, data files 0600). Nothing is published under public_html.
There is no SQL/Redis database, exchange socket, or new Rust binary.

~~~bash
export QSYN_RUNTIME_DIR=/absolute/path/to/private/qsyn/runtime
python3 /absolute/path/to/private/qsyn/app/tools/upstox-bod-master-refresh.py --download
~~~

The runtime directory must already exist, be canonical, owner-controlled and
private (0700). With predownloaded official gzip files, use:

~~~bash
python3 /absolute/path/to/private/qsyn/app/tools/upstox-bod-master-refresh.py \
  --nse-file /private/NSE.json.gz --bse-file /private/BSE.json.gz
~~~

A successful refresh imports **both** files and then atomically publishes a
`current.json` pointer. If either file is invalid, the previous catalog remains
active. This CLI should run after the provider's daily BOD refresh (e.g. after
06:30 IST), using the operator's existing approved schedule; there is no
background downloader started by the QSYN app.

In the authenticated QSYN Terminal, go to **Markets → Indian exchange
instrument catalog → Full NSE/BSE master**. Choose NSE or BSE; browse EQ,
FO, INDEX, CURR, COMM or ALL, filter on name/symbol and navigate in pages
of 20. Results may show unavailable selection scopes when no private Upstox
Analytics Token is configured. The master can still be browsed without a token.

## Security and scope

- Public homepage and seven existing index feeds are unchanged.
- The master API `/qsyn/api/v1/admin/upstox/instruments/master` is gated
  by the existing admin cookie. No anonymous bulk download endpoint.
- Client cannot supply a URL, file path or broker credentials.
- PHP streams one private NDJSON file, bounds request parameters and output,
  and fails closed for truncated/insecure snapshots.
- Provider instrument keys are returned only as discovery metadata. A
  short-lived selection scope can be issued only through the existing
  authenticated, private-token history path.
- There is **no** assumption of available real-time subscriptions, historical
  candles, volume, derivatives display rights or order execution.
- Snapshot refreshes are not performed during HTTP requests.

## Acceptance

~~~bash
python3 apps/web-php/tests/UpstoxBodMasterImportTest.py
php apps/web-php/tests/UpstoxMasterCatalogTest.php
cd frontend && node tests/upstox-master-catalog.test.mjs
~~~

Deployment acceptance requires a green QSYN CI and DigiOps Release, then an
authorized operator import and live-browser verification. **Publishing a
release artifact does not refresh the Cloudways private instrument catalog.**

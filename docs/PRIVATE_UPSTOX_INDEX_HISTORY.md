# QSYN native Upstox — private index historical candles (operator-only)

## Scope

This change adds real historical 1-minute **NSE/BSE index OHLC** import and
an independently authenticated private read endpoint. No database or Python
service is introduced. CE/PE option history and public chart routes remain
unchanged. **Source code and CI are not evidence of actual Upstox rights,
market-data exchange events, Cloudways process uptime, or broker orders.**

Upstox API:
https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/

## Operator preconditions

The Cloudways operator must separately verify and provision:

1. A current native Upstox OAuth bearer with the exact expected account ID.
2. An independently verified *today's IST* Upstox BOD mapping, matching
   every index instrument in the private index worker plan.
3. A valid private chart rights file with explicit account/owner/tenant
   display permission and licensed persistence/retention approval for each key.
4. Owner-only 0600 files and existing 0700 WAL and index-history archive
   directories, outside any webroot.
5. Authenticated TLS reverse proxy at exactly
   `/qsyn/private-chart/index-history` to the loopback service, preserving
   the Authorization header and independently authenticating each user.

A successful OAuth profile check or a matching instrument key does **not**
grant market-data display or storage permission. Do not create rights by
changing boolean flags unless the external authorization is documented.

## Private CLI

After above approvals, example operations:

```bash
/ABS/PRIVATE/app/bin/qsyn-upstox-index-history check \
  /ABS/PRIVATE/config/index-worker-plan.json \
  /ABS/PRIVATE/index-history 'NSE_INDEX|Nifty 50' 2026-10-09

QSYN_UPSTOX_INDEX_HISTORY_ENABLE=1 QSYN_TRADING_ENABLED=0 \
  /ABS/PRIVATE/app/bin/qsyn-upstox-index-history backfill \
  /ABS/PRIVATE/config/index-worker-plan.json \
  /ABS/PRIVATE/index-history 'NSE_INDEX|Nifty 50' 2026-10-09
```

Dates are bounded to the most recent 30 calendar days in IST. Data are
fetched over verified HTTPS with bounded payload size from the official
Upstox V3 endpoint. The importer rejects malformed dates, instrument keys,
source timestamps, duplicate candle minutes, invalid prices, and stale
mapping/rights. Empty official trading-day history produces a no-write
result, not synthetic candles. Each nonempty day becomes an immutable,
CRC-audited index-specific QCB archive scoped to account and license.

The QCB v1 archive preserves provider OHLC but *not* provider index volume
(an unavailable or null index volume is **never** reconstructed). There is
no promise of full history coverage until operator audit.

## Account-scoped read path

```bash
/ABS/PRIVATE/app/bin/qsyn-private-index-history check \
  /ABS/PRIVATE/config/index-worker-plan.json \
  /ABS/PRIVATE/config/chart-signing.key \
  /ABS/PRIVATE/index-history 10447
```

With independently approved Cloudways supervision and private ingress, use
the disabled-by-default Supervisor template. To run requires
`QSYN_PRIVATE_INDEX_HISTORY_HTTP_ENABLED=1` and live trading flags off.
The Rust service binds only to `127.0.0.1:10447`, rechecks current
operator BOD/session/retention/display rights, validates the 30-second
PHP chart ticket and exact account/instrument/tenant/owner/license, and
reads only CRC-audited private partitions. It returns no-cache JSON under
`QSYN-UPSTOX-PRIVATE-INDEX-HISTORY/1` and never exposes public candles.

The private React index chart requests a freshly signed chart ticket
before reading this endpoint. No index series are obtained through the
public `/qsyn/api/v1/india/bars` route. Missing rights, missing proxy,
missing archives or missing OAuth fail closed.

## Independent production acceptance

Verify six exchange symbols individually after current BOD attestation:
NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, INDIA VIX and SENSEX. Audit a
real provider historical response for each separately permitted index;
record sanitized timestamps/bar counts, account scope, archive audit
and rights expiry. Independently verify live index V3 feeds and at least
two seamless WSS grant renewals on a regular trading session. Market
closed != data unauthorized != no backfill. Never substitute demo candles,
start broker OMS, or permit anonymous index redistribution.

# QSYN Phase: Native Upstox index discovery and independent activation attestation

## Browser procedure

Open QSYN Terminal > Brokers > Upstox > Discover index instrument keys.
The server uses the private stored Upstox OAuth token, performs a fresh
read-only provider profile check, and queries the official Upstox
Instruments Search API for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY,
INDIAVIX and SENSEX.

The server uses a fixed api.upstox.com host, authenticated HTTPS, fixed
exchange and INDEX filters, exact segment/type/name matching and
bounded response size. No URLs or arbitrary keys can be supplied in the
browser. Pagination, ambiguity and missing keys are not approved.
The resulting JSON includes non-secret candidate instrument keys only;
a mapping found from search is NOT a current BOD attestation, approved
market data entitlement or permission to start Rust.

Provider: https://upstox.com/developer/api-documentation/instrument-search/
Master: https://upstox.com/developer/api-documentation/instruments/

## Independent Rust worker gate

The private worker settings require a new absolute path named
private_index_mapping_file. This file is 0600, owner-only, outside any
webroot, and must be provisioned by an authorized Cloudways operator
AFTER comparing the candidate keys to the official current Upstox BOD JSON.

Required JSON schema QSYN-UPSTOX-INDEX-BOD-MAPPING/1:
tenant, account, owner, upstox_user_id, source,
checked_at_ms, bod_date_ist, operator_attested, instruments.
The source must be operator_checked_official_upstox_bod_json.
Attestation must be from the current IST calendar date, within 16 hours
and not in the future. Its scope and the entire exchange, symbol and
instrument-key list must exactly match the worker plan.

Even an operator-attested BOD file is NOT a market-data license.
The existing distinct exchange display, retention and private chart
rights records must be independently verified and current.
The worker remains disabled by default. No process auto-start,
broker trading, automatic entitlement changes or OpenAlgo Python.

On Sunday 11 October 2026 Indian exchanges are not in regular trading;
fresh index quote ticks are not expected while the market is closed.
Live market testing requires an authorized market session.

## Acceptance and rollback

CI uses fake provider responses and checks six fixed searches,
unknown/ambiguous/paginated failures, strict private credentials,
CSRF, account matching, and no license grant.
Rust rejects a stale IST day, mismatched scope/keys, missing file,
wrong file modes and missing operator attestation.
The public chart-only homepage and unlicensed India-bars HTTP refusal
stay unchanged. If activation is not authorized, do not set operator
rights flags or enable Cloudways supervision.

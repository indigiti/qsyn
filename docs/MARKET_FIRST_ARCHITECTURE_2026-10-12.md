# QSYN market-first architecture (Phases 1–4 integrated)

**Status:** source migration; production market activation separately gated.
This replaces feature-by-feature sidebar growth with a canonical *market → venue
→ provider → scoped instrument → evidence* structure. Trading, tokens, exchange
entitlements, and public price distribution remain separate trust boundaries.

## Product organization

- Markets (terminal default): Crypto, Indices, Stocks, Options. Do not advertise
  planned Stocks or licensed India feeds as operational when they are not.
- Workspaces & Templates: preserve existing native OpenAlgo indicator templates,
  IndexedDB layouts, and legacy browser/private file formats. No destructive migration.
- Strategy Studio: consumes the same validated source-boundary module as the
  market explorer, but remains explicitly **deterministic simulation**, not OMS.
- Data Providers & Connections: existing Upstox OAuth/Analytics Token and
  other OpenAlgo broker setup flows preserved, renamed as provider management.
- Diagnostics, Rust Runtime, Route management: operator capabilities remain
  behind their existing authentication, CSRF, and host gates.

The public chart-only **/qsyn/** is unchanged. The **/qsyn/terminal** alias now
opens Markets. Old deep links remain valid; **/qsyn/terminal/trading** is
a simulation-only **Legacy Chart Lab** reached by explicit old URL, not
promoted as executable trading. Dashboard and Tools also remain reachable via
existing URLs for non-destructive compatibility. No broker order controls were
enabled or new runtime binaries introduced.

## Source-of-truth contracts

`apps/web-php/public/market-provider-registry.json` is the shared,
credential-free, reviewed registry read by the React build and the GET
`/qsyn/api/v1/markets/catalog` metadata endpoint. Exactly four asset families,
seven public crypto providers, and separate broker vs simulation provider
records are declared. Venue IDs identify exchanges, and provider IDs identify
the actual price source; these are not interchangeable.

`frontend/src/market-model.js` enforces market/provider combinations,
tenant/account-scoped instrument identity, read-only provider evidence, and
Strategy Studio simulation provenance. All provider health displays distinguish
a valid adapter/health endpoint from verified history, socket continuity,
exchange rights, and current candle timestamps. An Analytics Token that
passed read-only V3 authorization is **not** a live index subscription or
redistribution permission.

Crypto market selector reuses the existing OpenAlgo Charts grid and public
Rust/PHP feed; native workspace, indicator and watchlist facilities remain.
NSE/BSE index selector exposes the pre-existing authorized private index
chart controls within Markets, which are fail-closed without a signed
grant, approved instrument, rights, index worker, historical reader and WSS.
No fake Indian candles are substituted. Stocks explicitly shows unavailable;
Options explicitly offers Strategy Studio's simulated source and locked private
CE/PE access. The existing source handles provider tokens privately.

## Four-phase acceptance matrix

| Phase | Source-complete criterion | Operational acceptance |
| --- | --- | --- |
| 1 — provider model | versioned shared schema, source-scoped keys, negative-security tests | staging PHP metadata matches packaged registry |
| 2 — terminal migration | Markets default, no Trading primary nav, legacy links preserved | authenticated desktop/mobile smoke, chart persistence, CSP |
| 3 — data sources | reuses public seven-venue crypto plus account-scoped index gateway | separately approved real NIFTY/BANKNIFTY exchange timestamps on Cloudways |
| 4 — studio/templates | shared strict simulation adapter, unchanged layout/template keys | browser save/reopen, options payoff and no broker order API calls |

**Current blocker for Phase 3 real feed:** Cloudways operator must have valid
read-only Upstox Analytics session, independently attested *current* BOD
instrument keys, account and exchange display/retention rights, secure private
worker plan and supervision, a properly authenticated private WSS + history
reader, and real tick/candle exchange timestamps. Token verification
`UPSTOX_ANALYTICS_MARKET_AUTHORIZED_NOW` only confirms V3 authorize at
check time. Source CI cannot start a Cloudways process. Never enable public
`/qsyn/api/v1/india/bars` as a shortcut; never fabricate live data.

## No-new-fragmentation rules

1. Provider addition = schema entry, explicit adapter and capability evidence;
   not a new terminal page, unrelated OHLC convention, or independent binary.
2. Existing `qsyn-stream` one-ELF release footprint and 10 compatibility
   launchers remain frozen. CI release/size checks must pass.
3. Chart cache keys include market, venue, provider, instrument and
   account identity for private market data; no cross-account sharing.
4. Live/simulated sources never fall back to each other. Provider selection
   does not imply authorization or automatic failover.
5. No trading navigation, orders, public NSE/BSE publication, or new
   entitlement flags without independent reviewed production acceptance.
6. Preserve all route aliases, native OpenAlgo workspace/indicator templates
   and old layout storage; perform any migration as an explicit opt-in copy
   with rollback and security tests.
7. Any claim that a source is operational needs a fresh time-bounded
   health/history/live candle observation in the actual deployment, not
   just a green GitHub CI or valid OAuth bearer.
8. Enforce PR and CODEOWNER review plus footprint, tests and release artifact
   gates in GitHub branch rules; tracked by Issue #118.

**Operational monitoring:** Issue #105 tracks real licensed NSE/BSE feed
acceptance; Issue #108 tracks the blocked external staging browser/HTTP 403.
No host credentials or exchange tokens belong in repo, logs, or chat.

# QSYN Phase 6 — Authenticated private historical chart delivery

**Source-only milestone; no externally verified Upstox session or Cloudways process activation.** This phase completes the data path from previously imported **private historical option-leg QCB files** into the separate authenticated React CE/PE charts, not into the public demo terminal. PHP + Rust + private files, no database or Python service.

## Private history reader

`qsyn-private-history` is a **standalone, disabled-by-default** Axum HTTP service restricted to 127.0.0.1. It exposes only:

`GET /qsyn/private-chart/history`

Required header: `Authorization: Bearer <30-second PHP chart ticket>`, never a URL/query parameter. The PHP private issuer at `POST /qsyn/api/v1/terminal/private-chart-grant` requires current developer/test identity, CSRF and actual operator-scoped rights. Tickets and provider tokens must never be logged, persisted to browser storage or exposed through query strings.

The Rust history reader validates the signature, 30-second expiry, audience, owner, tenant, account, broker, option instrument and license ID against the **current private rights file** and the separately approved private worker plan **on every request**. It requires a currently available private operator OAuth session and independently confirmed rights to both display and retain history. It reads only the CE or PE series named in the verified grant. Unavailable, corrupt, expired, foreign-tenant or mismatched archives fail closed; missing holiday/unimported dates return an empty set without synthetic substitutions.

The QCB historical candles are bounded to 1,200 rows, within the previous 30 calendar days in IST, have a CRC-verified header and all records audited before response. An immutable partition is one exchange option instrument and trading day, **not an invented synthetic basket**. Returns the following fields for valid licensed operator data:

```json
{
  "schema": "QSYN-UPSTOX-PRIVATE-HISTORY/1",
  "source": "licensed_private_history",
  "account": "approved-private-account",
  "instrument": "NSE_FO|12345",
  "exchange": "UPSTOX_PRIVATE",
  "interval": "1m",
  "trading_enabled": false,
  "public_redistribution_allowed": false,
  "history_complete": false,
  "bars": [{"time": 1791527100, "open": 100, "high": 103, "low": 99, "close": 102}]
}
```

**The JSON above is an illustrative schema, not an actual exchange record.** Imported history remains explicitly marked *coverage not independently certified* until an operator audits missing dates and possible data gaps. No consolidated synthetic CE+PE OHLC is calculated from separate leg highs/lows.

## React chart subscription

The separate `/qsyn/terminal?view=private-live` view obtains a **new** scoped PHP ticket before requesting the same-origin historical route. The historical reader never sees the real provider token or arbitrary client-selected broker account. React accepts only a matching account, instrument, exchange, interval, licensed source, bounded monotonic numeric candles and disabled order flags. If offline or unauthorized, it shows **no history**, never demo candles. WSS remains an independently authenticated private service and may show partial streaming while history is unavailable.

The default simulation workspace at `/qsyn/terminal?view=trading` remains unchanged.

## Operator activation — blocked pending evidence

1. The operator must first complete actual Upstox OAuth on a private Cloudways host and separately attest rights to display *and retain* exchange data for the named account and real CE/PE listed instruments.
2. Use `qsyn-upstox-history check`, then authorized daily `backfill` and manually audit both CE and PE immutable QCB files. No public provider credentials are embedded in the artifact.
3. Start `qsyn-private-history check <private worker-plan> <private signing key> <private archive dir> 10446` as a filesystem/account preflight. It does **not** connect to Upstox.
4. With separately approved Cloudways process supervision, start the provided `[program:qsyn-upstox-v3-history-ACCOUNT_A]` example **only in an isolated private account runtime**. The example is `autostart=false`.
5. A **separately approved** HTTPS reverse proxy must route only `/qsyn/private-chart/history` to loopback `127.0.0.1:10446`, preserve the `Authorization` header and reject foreign origins; never publicly expose the raw TCP port. The signed ticket is the Rust-side authorization check; the proxy must additionally authenticate the private user/session.
6. Record non-sensitive evidence: authorized CE/PE archival dates and bar counts, account scope, active rights expiry, tampered/expired ticket rejection, no anonymous history, HTTP response cache denial, WSS authenticated reconnect, exchange timestamp monotonicity and restart recovery.
7. **Do not enable live order submission**. Broker OMS requires a distinct live order adapter, actual order reconciliation, risk gates, exchange/broker approvals and final human sign-off.

## Verification and non-goals

- Rust unit tests create fake owner-only private OAuth, rights, signed grants and QCB files. They verify correct CE data, PE separation, revoked rights denial, account swapping, token expiry, no public bearer access and historical file scope.
- JavaScript tests verify signed requests through the same-origin private endpoint; foreign account, duplicate/invalid OHLC response rejection; and absence of simulated fallback.
- DigiOps validates that `qsyn-private-history` is bundled in the **private** release and that public homepage/terminal flows still pass.
- **Not yet verified:** Cloudways process installation/uptime, genuine Upstox OAuth, a real market V3 CE/PE stream, actual licensed archived candles, per-user production identity, and private reverse proxy acceptance.
- **Never claim** a real broker stream or production trading based on CI, a deployed artifact, or an operator configuration template.

Official provider historical API description: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/. Provider V3 authorization: https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3/.

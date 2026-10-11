# QSYN homepage console audit — public markets

Scope: QSYN chart-only /qsyn/ and embedded public Markets chart on commit 104c0cb0de9a, OpenAlgo Charts 2.6.0 with native public crypto and discoverable but unlicensed NSE/BSE symbols.

## Source findings

- The repeated /qsyn/api/v1/india/bars HTTP 503 responses are the expected authorization-denied contract from IndiaIndexCatalog.php. No licensed NSE/BSE history is deployed. The public QsynMarketsFeed had been requesting index bars on each selected timeframe before caching the denial per symbol/interval, needlessly filling DevTools with 503 failures.
- The chart engine cancels obsolete requests on interval/symbol/grid changes and when destroying widgets. QsynCryptoFeed and QsynMarketsFeed previously rethrew fetch AbortError; upstream OpenAlgo 2.6 chart teardown can also reject an internal cancelled promise without attaching a handler.
- The deployed CSP is script-src 'self'. The QSYN terminal.php page template contains only one external script src=/qsyn/assets/terminal.js; no inline script. Thus an inline-script violation at document line 16 may indicate a hosting/proxy-injected script or extension injection, or a deployed HTML response different from this template. The strict CSP must NOT be weakened to unsafe-inline, and external inspection of the authenticated staging response is still required.

## Corrections

1. Public chart index instruments continue to appear in native OpenAlgo symbol search but their getBars returns [] with the explicit licensed-access-required state **before requesting** /qsyn/api/v1/india/bars. No fake NSE/BSE candle fallback. Future approved account-scoped private chart code may opt into API attempts, but server-side licenses remain mandatory.
2. Aborted fetches from public crypto/index adapters now resolve with [] rather than propagating AbortError into chart refresh.
3. A narrowly scoped client listener handles only explicitly recognized AbortError messages from OpenAlgo's internal cancellation lifecycle while the homepage chart is mounted. It does NOT swallow HTTP errors, TypeError, syntax failures or CSP violations. The observer is removed during teardown.
4. Browser and unit contract regressions assert zero public index request attempts, fail-closed authorized index responses, clean aborted requests, and that the served HTML contains no inline scripts and retains strict CSP.

## Remaining operational requirements

The server must retain 503 for direct unauthorized access to /qsyn/api/v1/india/bars. NSE/BSE live chart activation requires separate Upstox index instrument mapping, exchange license and Rust streaming verification. A source-only patch does not activate prices.

If CSP inline errors persist after this release: inspect Chrome DevTools > Network > document qsyn/ > Response, find line 16 and report only whether the inline <script> is from a browser extension, Cloudways/edge injection, or QSYN; do not paste cookies, credentials or raw bearer headers. Test a clean Incognito window without extensions. Do not add unsafe-inline to CSP.

Other unrelated 'frame_ant.js' errors can originate from installed extensions; the source should be identified in DevTools before changing QSYN.

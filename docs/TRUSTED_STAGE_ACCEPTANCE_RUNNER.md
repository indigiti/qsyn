# QSYN read-only staging acceptance through a trusted fixed-egress runner

## Why the default workflow is red

QSYN Stage Historical Acceptance #4, attempts 1 and 2, recorded `HTTP 403` on both the anonymous homepage and the public Binance API. Diagnostic JSON included `server: cloudflare` and `cf-mitigated: challenge`. Neither the 1,600 nor 15,016 live candle checks ran to completion. A successful GitHub CI or DigiOps artifact **does not confirm Cloudways deployment**.

Cloudflare's challenge is not an indication that candles are invalid. Do not turn off the sitewide WAF, bot protection, CSP, OAuth controls, admin login protections or OMS risk controls just to make an acceptance workflow pass.

## Available execution modes

`QSYN Stage Historical Acceptance` is a manually triggered workflow (`workflow_dispatch`), restricted to the reviewed `main` branch. It takes two choices:

- `bars=1600` or `bars=15016`: respectively requests six or 51 real Binance BTCUSDT 1m pages from the existing public QSYN API, with strict gap/cursor/OHLCV checks. In either mode, independent Chromium validates the initial native chart 1,600-candle load.
- `runner_mode=github-hosted` (default): standard GitHub `ubuntu-latest`, which Cloudflare currently challenges with 403. Leave this mode for monitoring the access-control diagnosis.
- `runner_mode=trusted-self-hosted`: dedicated private Linux x64 runner with required labels `self-hosted`, `linux`, `x64`, and **`qsyn-stage-acceptance`**. A fixed public egress IP must be supplied by the runner operator and narrowly allowed by Cloudflare **only after reviewing the actual Ray ID/security rule**.

> Selecting trusted-self-hosted does not create/register a runner, assign a fixed IP, edit Cloudflare or deploy QSYN. If no runner has all required labels, the job remains queued and no live check occurs.

## Operator provisioning — security requirements

1. Provision a **separate isolated runner VM**, not the Cloudways production PHP/Rust host. Private QSYN repository/organization access only; untrusted PRs must not execute on this runner. Give the runner the label `qsyn-stage-acceptance`. Prefer ephemeral, disposable instances and minimal host/network privileges. GitHub settings: `indigiti/qsyn → Settings → Actions → Runners`. Follow GitHub's registration wizard; do not post a runner registration token or shell command containing it.
2. Use a **stable outbound IPv4 address** or a verified fixed-egress network gateway. Independently determine the public IP from infrastructure/network tooling and use only that **single** source address for Cloudflare matching. Do not allow the entire GitHub-hosted runner ASN or any shared public cloud CIDR.
3. Preinstall Node.js 22-compatible Linux dependencies needed for Playwright Chromium and network access to GitHub/npm; the workflow installs Playwright itself, and does **not** install OS packages with sudo on the trusted runner. Workflows are restricted to `main`; the token permission remains `contents: read`.
4. At Cloudflare for `stage.digiti.in`, open **Security → Events** and search a recent failing `cf-ray` from `stage-access-report.json`. Record the matched service, security rule ID and action (Managed Challenge/Block). Determine whether the rule lives in Custom Rules, Managed Rules, Super Bot Fight Mode or Bot Fight Mode. In particular, **Bot Fight Mode cannot be selectively skipped**; do not assume an exception can work on the current plan.
5. **Only if the matched security product supports a narrowly scoped rule**, create the smallest appropriate Skip/exception action for the trusted fixed source IP, exact host, GET requests and required public chart/history paths. Example Cloudflare expression **template** — replace `203.0.113.17` with the operator-verified fixed egress IP (the example address is a documentation-only placeholder; never deploy it as-is):

```text
(http.host eq "stage.digiti.in"
 and ip.src eq 203.0.113.17
 and http.request.method eq "GET"
 and (
   http.request.uri.path eq "/qsyn/"
   or http.request.uri.path eq "/qsyn/api/v1/health"
   or http.request.uri.path eq "/qsyn/api/v1/crypto/bars"
   or starts_with(http.request.uri.path, "/qsyn/assets/")
 ))
```

Choose **Skip only for the confirmed challenging security rule/product**. Do not broadly skip unrelated managed rules, rate limiting, every custom rule or administrator/trading routes. Confirm in Cloudflare Security Events that the resulting access is restricted to the intended trusted source and public GET routes. Maintain Cloudflare's normal security processing for all other traffic.

6. Confirm the most recent DigiOps release artifact has actually been deployed to Cloudways and that the stage frontend/backend correspond to the intended commit. This acceptance check is read-only and cannot deploy it.
7. Open `Actions → QSYN Stage Historical Acceptance → Run workflow`; use branch `main`, `bars=15016`, `runner_mode=trusted-self-hosted`. The job will run independent API and Chromium checks, and will **fail closed** unless both pass.
8. Download `qsyn-stage-history-acceptance` and inspect `stage-access-report.json`, `stage-backfill-report.json`, and `stage-chart-report.json`. A true green result establishes live API fetches of 15,016 candles and the default 1,600-candle native Chromium chart load. **It does not by itself verify the browser retains all 15,016 candles when Wick Science is set to 15m/1000; that requires a separate maximum-lookback browser test.**

## Alternative where no trusted runner is available

Use the existing public staging site in a browser session where Cloudflare permits access and run the read-only provider acceptance from an **authorized** network location. A fixed-egress runner is not mandatory to validate candles, but automated GitHub-hosted CI continues to fail the perimeter challenge. Do not copy auth cookies, disable Cloudflare protections, replay challenge tokens or spoof headers to obtain access.

## Source documentation

- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow
- https://docs.github.com/en/actions/reference/security/secure-use
- https://developers.cloudflare.com/waf/custom-rules/skip/
- https://developers.cloudflare.com/waf/feature-interoperability/
- https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/

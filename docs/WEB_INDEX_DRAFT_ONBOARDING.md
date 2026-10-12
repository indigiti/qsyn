# QSYN connection wizard and private index drafts

At **Terminal → Data providers & connections**, QSYN now presents four guided stages:
Providers → Upstox access → Private setup → Validate. Public crypto providers remain
separate from account-scoped Upstox permissions. The existing token, OAuth, index
discovery, history, worker, and chart APIs are reused; no extra Rust service or DB.

## What the web can do without the Cloudways console

An administrator with the existing secure session and Upstox private token can
press **Prepare private index files**. The server independently discovers all
six currently searchable Upstox index *candidates* and creates owner-only files
under the same canonical `QSYN_RUNTIME_DIR/upstox-private` used for the token:

- `index-worker-plan.json` (0600; exact `QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1` shape)
- `index-bod-mapping.json` (0600; exact mapping shape but **not attested**)
- `index-history/`, `index-wal/`, and `charts/` (0700 private directories)

This happens via `POST /qsyn/api/v1/admin/index-prepare/prepare` with same-origin
admin CSRF protection. The request contains only confirmed local tenant/owner/
account aliases. It cannot carry tokens, executable paths, instrument keys,
rights, proof flags, URLs, Supervisor commands, or an arbitrary JSON document.
No existing private plan or attestation is overwritten. Set
`QSYN_INDEX_PRIVATE_PREPARE_ENABLED=0` to disable the preparation action.

The existing `/admin/index-ops/status` endpoint now prefers an operator-configured
external plan/archive if explicitly set, otherwise safely discovers the managed
private plan and archive inside `QSYN_RUNTIME_DIR`. A private draft is reported
distinctly as `INDEX_PLAN_DRAFT_PENDING_RIGHTS` rather than *not provisioned*.
No new environment variable is needed for the canonical file paths.

## What the web **cannot** lawfully authorize by itself

The created plan is **not runnable**. Its `rights_expire_ms` is 0, display
and retention flags are false, the BOD mapping uses
`candidate_instrument_search_not_attested` with `operator_attested=false`,
and no exchange-rights record is generated. All these gates must remain closed
until the correct account, provider instrument-master BOD and independently
evidenced exchange display/retention rights have been audited.

An authorized operator must separately update the private audited plan,
mapping and rights evidence, then approve a dedicated index-only Supervisor
and authenticated WSS/history ingress if the host supports them.
A browser admin password or stored read-only Analytics Token cannot grant
these privileges. No live quotes or licensed candles may be claimed until
exchange timestamps and account-scoped private chart grants are verified.

**No user-facing action should silently overwrite an existing private plan.**
If the operator has already configured a different absolute private plan path,
the wizard rejects preparation and explains that host review is required.

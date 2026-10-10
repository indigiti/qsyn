# Clarifications and locked decisions

1. UI: preserve shipped upstream OpenAlgo Charts integration without replacing its controls; upstream full trading app remains independent.
2. Existing integration: use upstream OpenAlgo broker plugins and authorization; QSYN provides scoped orchestration and chart adapter, not browser-based credentials.
3. Account model: many distinct linked accounts per QSYN user; separate Upstox A/B contexts and one additional broker must be tested.
4. Current rollout: operator-only CLI and private network first; do not expose new live market/public trading APIs before entitlement and authorization.
5. Data license: successful login or API ping is not entitlement/redistribution proof.
6. Trading: retain an explicit disabled status; build durable paper OMS first; later live execution requires separate approval, not an environment toggle.
7. Storage: keep existing mock file adapter for CI and controlled dev; real multi-user production storage and key lifecycle require security sign-off.
8. Deployment: GitHub CI and DigiOps artifact are separate from verified Cloudways health and actual broker connectivity.
9. Auth: broker secrets belong to upstream private instances and owner-only files; no OAuth callbacks routed through anonymous QSYN web pages.
10. Unknown external details: customer-specific broker apps, exchange market-data licenses, callback origins, hosting ACL, backup policy and execution permissions need operator evidence rather than assumptions.

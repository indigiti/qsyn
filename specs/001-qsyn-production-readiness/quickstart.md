# Operator-only private broker readiness

Requires PHP CLI, a privately installed upstream OpenAlgo per distinct broker account, a 0600 registry JSON outside public webroot and separate 0600 application API key files. Use the controls in docs/OPENALGO-PRIVATE-MULTI-BROKER-INTEGRATION.md. Never add secrets to GitHub.

```sh
export QSYN_PRIVATE_BROKER_GATEWAY=1
export QSYN_OPENALGO_REGISTRY_FILE=/ABSOLUTE/PRIVATE/openalgo-registry.json
php apps/web-php/tools/private-broker-gateway.php list tenant-approved owner-approved
php apps/web-php/tools/private-broker-gateway.php readiness tenant-approved owner-approved
```

`readiness` only returns scoped account IDs, fixed metadata and coarse broker-session health. A responding broker is marked `private_session_only`, not licensed, permitted for public charts, or eligible for order execution. An unavailable or wrongly authenticated provider is `session_not_verified`; other accounts continue independently. No quote payload, token, private path, broker's raw failure or user order is emitted.

Offline acceptance:
```sh
python3 apps/web-php/tests/PrivateBrokerGatewayTest.py
php -l apps/web-php/tools/private-broker-gateway.php
```

Review the GitHub PR checks before merging or deploying. This cannot attest actual Cloudways ingress, licensed market data or live order permissions.

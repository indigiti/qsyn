# QSYN × DigiOps — deployment artifact contract

DigiOps' own installation documentation supports a release-root public/index.php entrypoint (or dist/index.html, index.php, index.html). It does not recognize the former nested public_html/qsyn/index.php as the artifact entrypoint.

Documentation: https://github.com/indigiti/DigiOps/blob/main/docs/INSTALL.md

## DigiOps target configuration

- Browser route: /qsyn/
- Public deployment destination: public_html/qsyn/
- Private deployment destination: private_html/qsyn/
- Artifact name: digiops-release

These Cloudways destination prefixes are configured in DigiOps, NOT embedded in the ZIP. DigiOps maps release/public to public_html/qsyn and release/private to private_html/qsyn.

## Exact ZIP paths

~~~text
public/
  index.php               # app entrypoint
  .htaccess               # include-hidden-files: true required
  assets/chart.js
  licenses/openalgo-charts-LICENSE.txt
private/
  app/src/FileStore.php
  app/bin/qsyn-stream
  build/release.json
RELEASE.json
~~~

GitHub Actions stages these paths and uploads an artifact named digiops-release. A separate verify-artifact job downloads the ZIP and confirms public/index.php, .htaccess, the compiled chart JS and the manifest exist.

### Explanation of ENTRYPOINT_MISSING

The earlier artifact had public_html/qsyn/index.php *inside the ZIP*. DigiOps only accepted entrypoints at documented release-root paths. The earlier workflow also omitted include-hidden-files: true, which excluded .htaccess. Both are corrected by the new release workflow.

## Review and deployment checks

1. Confirm both QSYN DigiOps Release jobs, package and verify-artifact, pass on main.
2. In DigiOps click Check update and verify the new exact workflow run, SHA and digiops-release artifact.
3. Deploy the verified Phase 0 payload; inspect /qsyn/ and /qsyn/api/v1/health.
4. Leave Rust in private/app/bin as a compiled artifact only, NOT a public CGI script. Daemon supervision/WSS proxy and Cloudways capabilities still require verification.
5. Keep persistent storage and credentials outside release-managed paths.
6. No live Upstox connection, trading, or real broker secrets are enabled in Phase 0.

The OpenAlgo Charts JS is built in GitHub Actions. No production Node.js server is required.

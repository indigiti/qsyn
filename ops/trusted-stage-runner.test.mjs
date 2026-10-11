import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const workflow=await readFile(new URL('../.github/workflows/stage-backfill-acceptance.yml',import.meta.url),'utf8');
const instructions=await readFile(new URL('../docs/TRUSTED_STAGE_ACCEPTANCE_RUNNER.md',import.meta.url),'utf8');

test('manual trusted-stage option keeps default runner and requires reviewed main',()=>{
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/runner_mode:/);
  assert.match(workflow,/default: 'github-hosted'/);
  assert.match(workflow,/- 'trusted-self-hosted'/);
  assert.match(workflow,/if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/runs-on:.*inputs\.runner_mode.*fromJSON.*qsyn-stage-acceptance/);
  assert.match(workflow,/\|\| 'ubuntu-latest'/);
  assert.doesNotMatch(workflow,/\bpull_request:/);
  assert.match(workflow,/permissions:\n  contents: read/);
});
test('CI preserves real API and native Chromium validation with fail-closed artifacts',()=>{
  assert.match(workflow,/--bars "\$QSYN_BARS"/);
  assert.match(workflow,/id: history/);
  assert.match(workflow,/id: chart/);
  assert.match(workflow,/stage-access-report\.json/);
  assert.match(workflow,/stage-backfill-report\.json/);
  assert.match(workflow,/stage-chart-report\.json/);
  assert.match(workflow,/HISTORY_OUTCOME.*!= success \|\|.*CHART_OUTCOME.*!= success/);
  assert.match(workflow,/if: inputs\.runner_mode == 'github-hosted'/);
  assert.match(workflow,/if: inputs\.runner_mode == 'trusted-self-hosted'/);
  assert.doesNotMatch(workflow,/(GITHUB_TOKEN|secrets\.)/);
});
test('Cloudflare runbook requires fixed IP, exact public GET scope and targeted security action',()=>{
  assert.match(instructions,/fixed public egress IP/);
  assert.match(instructions,/ip\.src eq 203\.0\.113\.17/);
  assert.match(instructions,/http\.request\.method eq "GET"/);
  assert.match(instructions,/http\.request\.uri\.path eq "\/qsyn\/api\/v1\/crypto\/bars"/);
  assert.match(instructions,/Bot Fight Mode cannot be selectively skipped/);
  assert.match(instructions,/does not by itself verify the browser retains all 15,016 candles/);
});

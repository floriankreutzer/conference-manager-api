import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runInventoryDiagnostic } from '../scripts/jira-github-inventory-diagnostic.mjs';

test('diagnostic uses real collector but emits only counts and no readiness authority', async () => {
  const lines = [];
  const secret = 'test-only-diagnostic-token';
  const code = await runInventoryDiagnostic({ token: secret, write: (line) => lines.push(line),
    fetchImpl: async (url) => {
      const repository = new URL(url).pathname.slice('/repos/'.length, -'/pulls'.length);
      return new Response(JSON.stringify(url.endsWith('page=1') ? [{ number: 1,
        title: 'confidential title', draft: true, state: 'open', base: { repo: { full_name: repository } },
        head: { sha: 'a'.repeat(40), ref: 'confidential branch' } }] : []),
      { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { schemaVersion: 1, result: 'INVENTORY_ENUMERATED',
    readinessEvaluated: false, repositories: [
      { repository: 'floriankreutzer/conference-manager', count: 1 },
      { repository: 'floriankreutzer/conference-manager-api', count: 1 },
    ] });
  assert.equal(lines[0].includes(secret), false);
  assert.equal(lines[0].includes('confidential'), false);
});

test('diagnostic failure emits no provider exception or partial counts', async () => {
  const lines = [];
  const code = await runInventoryDiagnostic({ token: 'test-only-diagnostic-token',
    write: (line) => lines.push(line), fetchImpl: async () => { throw new Error('private provider detail'); } });
  assert.equal(code, 1);
  assert.deepEqual(lines.map(JSON.parse), [{ schemaVersion: 1,
    result: 'GITHUB_INVENTORY_UNVERIFIED', readinessEvaluated: false }]);
});

test('executable fails closed without credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/jira-github-inventory-diagnostic.mjs'],
    { cwd: new URL('..', import.meta.url), env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).result, 'GITHUB_INVENTORY_UNVERIFIED');
});

test('workflow binds secrets to manual main-only read access without publishing artifacts', () => {
  const workflow = readFileSync(new URL('../.github/workflows/jira-inventory-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  workflow_dispatch:\n\npermissions:\n  contents: read/);
  assert.match(workflow, /github.repository == 'floriankreutzer\/conference-manager-api' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /permission-pull-requests: read/);
  assert.match(workflow, /repositories: \|\n            conference-manager\n            conference-manager-api/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.doesNotMatch(workflow, /pull_request_target|schedule:|: write|skip-token-revoke|upload-artifact|npm |JIRA.*TOKEN/);
  for (const action of workflow.matchAll(/uses: (\S+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});

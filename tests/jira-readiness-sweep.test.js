import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runJiraReadinessSweep, loadJiraSweepConfig } from '../scripts/jira-readiness-sweep.mjs';

const env = { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule', CM_JIRA_TRANSITION_WRITER_ENABLED: 'true', CM_JIRA_READINESS_AUTOMATION_ENABLED: 'true',
  CM_JIRA_WRITER_ACCOUNT_ID: 'test-writer', CM_JIRA_REGISTER_DATABASE_HOST: 'ep-test-example.eu-central-1.aws.neon.tech',
  CM_JIRA_REGISTER_DATABASE_URL: 'postgresql://cm_jira_register_writer:test-only@ep-test-example.eu-central-1.aws.neon.tech'
    + '/conference_manager_demo_shared?sslmode=verify-full',
  CM_JIRA_CLOUD_ID: '11111111-1111-1111-1111-111111111111' };
const identity = { role_name: 'cm_jira_register_writer', database_name: 'conference_manager_demo_shared',
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, inherits_role: false };
const receipt = { result: 'JIRA_READINESS_GATES_BLOCKED', transitionSubmitted: false, transitionConfirmed: false, atTarget: false };
const failed = { result: 'JIRA_READINESS_SWEEP_UNVERIFIED' };
function harness() {
  const output = []; const calls = []; let listener; let closed = false;
  const pool = { on: (_event, callback) => { listener = callback; }, query: async () => ({ rows: [identity] }),
    end: async () => { closed = true; } };
  return { output, calls, pool, closed: () => closed, lost: () => listener(new Error('private connection payload')),
    options: { env, poolFactory: () => pool, write: value => output.push(JSON.parse(value)),
      discover: async () => ['CO-1'], select: async () => ({ issueKeys: ['CO-1', 'CO-2'], queueSize: 2 }),
      execute: async options => { calls.push(options.issueKey); assert.equal(options.deferConfirmation, false); return receipt; } } };
}
test('actual schedule or manual sweep context requires both independent activation flags', async () => {
  assert.equal(loadJiraSweepConfig(env).integration.actorId, 'test-writer');
  assert.equal(loadJiraSweepConfig({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }).database.max, 2);
  for (const change of [{ GITHUB_EVENT_NAME: 'workflow_run' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REPOSITORY: 'foreign/repo' },
    { CM_JIRA_READINESS_AUTOMATION_ENABLED: 'false' }, { CM_JIRA_TRANSITION_WRITER_ENABLED: 'false' },
    { CM_JIRA_READINESS_AUTOMATION_ENABLED: 'TRUE' }, { CM_JIRA_WRITER_ACCOUNT_ID: '' }]) {
    const h = harness();
    assert.equal(await runJiraReadinessSweep({ ...h.options, env: { ...env, ...change },
      poolFactory: () => assert.fail('must not connect') }), 1);
    assert.deepEqual(h.output, [failed]);
  }
});
test('queue recovery obligations absent from the candidate query still use the normal trusted composition', async () => {
  const h = harness();
  assert.equal(await runJiraReadinessSweep(h.options), 0);
  assert.deepEqual(h.calls, ['CO-1', 'CO-2']); assert.equal(h.closed(), true);
  assert.deepEqual(h.output, [{ result: 'JIRA_READINESS_SWEEP_COMPLETED', queueSize: 2, selected: 2,
    receipts: [{ issueKey: 'CO-1', ...receipt }, { issueKey: 'CO-2', ...receipt }] }]);
});
test('one failed issue does not starve the rest, expose payloads or claim no external write', async () => {
  const h = harness();
  assert.equal(await runJiraReadinessSweep({ ...h.options, execute: async ({ issueKey }) => {
    if (issueKey === 'CO-1') throw new Error('private provider response after accepted POST');
    return { ...receipt, private: 'must not log' };
  } }), 1);
  assert.deepEqual(h.output[0].receipts, [{ issueKey: 'CO-1', result: 'JIRA_READINESS_RUN_UNVERIFIED' },
    { issueKey: 'CO-2', ...receipt }]);
  assert.equal(h.output[0].result, 'JIRA_READINESS_SWEEP_PARTIAL');
});
test('discovery or queue uncertainty prevents processing instead of treating partial data as complete', async () => {
  for (const stage of ['discover', 'select']) {
    const h = harness();
    assert.equal(await runJiraReadinessSweep({ ...h.options, [stage]: async () => { throw new Error('private SQL'); },
      execute: () => assert.fail('must not process') }), 1);
    assert.deepEqual(h.output, [failed]); assert.equal(h.closed(), true);
  }
});
test('malformed or oversized queues and unknown execution receipts fail closed', async () => {
  for (const batch of [{ issueKeys: ['OTHER-1'], queueSize: 1 }, { issueKeys: ['CO-1', 'CO-1'], queueSize: 2 },
    { issueKeys: Array.from({ length: 6 }, (_, i) => `CO-${i + 1}`), queueSize: 6 },
    { issueKeys: ['CO-1'], queueSize: 0 }]) {
    const h = harness();
    assert.equal(await runJiraReadinessSweep({ ...h.options, select: async () => batch,
      execute: () => assert.fail('must not process') }), 1);
    assert.deepEqual(h.output, [failed]);
  }
  const h = harness();
  assert.equal(await runJiraReadinessSweep({ ...h.options, execute: async () => ({ ...receipt, result: 'unsafe text' }) }), 1);
  assert.ok(h.output[0].receipts.every(value => value.result === 'JIRA_READINESS_RUN_UNVERIFIED'));
});
test('connection loss during execution or cleanup cannot report completion or begin the next issue', async () => {
  for (const cleanup of [false, true]) {
    const h = harness(); let count = 0;
    if (cleanup) h.pool.end = async () => h.lost();
    assert.equal(await runJiraReadinessSweep({ ...h.options, execute: async () => {
      count++; if (!cleanup) h.lost(); return receipt;
    } }), 1);
    assert.equal(count, cleanup ? 2 : 1); assert.deepEqual(h.output, [failed]);
  }
});
test('automatic workflow has a protected hourly main-only entry and gates all privileged steps before secret injection', async () => {
  const workflow = await readFile(new URL('../.github/workflows/jira-readiness-sweep.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '23 \* \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|repository_dispatch:|secrets: inherit/);
  assert.match(workflow, /environment: jira-readiness-writer/);
  assert.match(workflow, /group: jira-readiness-writer/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.equal((workflow.match(/if: steps.activation.outputs.enabled == 'true'/g) ?? []).length, 3);
  assert.ok(workflow.indexOf('CM_JIRA_WRITER_API_TOKEN:') > workflow.indexOf('run: npm ci'));
  for (const line of workflow.split('\n').filter(value => value.includes('uses:'))) assert.match(line, /@[a-f0-9]{40} /);
});

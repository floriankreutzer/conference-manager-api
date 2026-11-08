import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadJiraReadinessConfig, runJiraReadiness } from '../scripts/jira-readiness-write.mjs';

const env = { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', CM_JIRA_TRANSITION_WRITER_ENABLED: 'true', CM_JIRA_WRITER_ACCOUNT_ID: 'test-writer',
  CM_JIRA_REGISTER_DATABASE_HOST: 'ep-test-example.eu-central-1.aws.neon.tech',
  CM_JIRA_REGISTER_DATABASE_URL: 'postgresql://cm_jira_register_writer:test-only@ep-test-example.eu-central-1.aws.neon.tech'
    + '/conference_manager_demo_shared?sslmode=verify-full',
  CM_JIRA_CLOUD_ID: '11111111-1111-1111-1111-111111111111', CM_JIRA_WRITER_EMAIL: 'test@example.invalid',
  CM_JIRA_WRITER_API_TOKEN: 'test-only-jira-token', CM_GITHUB_GATES_TOKEN: 'test-only-github-token', CM_JIRA_ISSUE_KEY: 'CO-296' };
const identity = { role_name: 'cm_jira_register_writer', database_name: 'conference_manager_demo_shared',
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, inherits_role: false };
const failed = { result: 'JIRA_READINESS_RUN_UNVERIFIED' };
const registered = { result: 'JIRA_REGISTER_UNCHANGED', readinessAuthorized: false };
const confirmed = { result: 'JIRA_READINESS_TRANSITION_CONFIRMED', transitionSubmitted: true,
  transitionConfirmed: true, atTarget: true };
function harness({ role = identity, cleanupFailure = false } = {}) {
  const output = []; let listener; let closed = false;
  const pool = { on: (_event, callback) => { listener = callback; }, query: async () => ({ rows: [role] }),
    end: async () => { closed = true; if (cleanupFailure) throw new Error('private cleanup payload'); } };
  return { pool, output, closed: () => closed, idleError: () => listener(new Error('private database URL')),
    options: { env, poolFactory: () => pool, write: value => output.push(JSON.parse(value)),
      publish: async () => registered, promote: async () => confirmed } };
}
test('protected runner uses isolated verified TLS and independently pinned actor identity', () => {
  const config = loadJiraReadinessConfig(env);
  assert.equal(config.integration.actorId, 'test-writer');
  assert.equal(config.integration.githubToken, env.CM_GITHUB_GATES_TOKEN);
  assert.equal(config.integration.deferConfirmation, false);
  assert.deepEqual(config.database.ssl, { rejectUnauthorized: true });
  assert.equal(config.database.max, 2);
});
test('invalid activation, source, actor, target, recovery mode or TLS performs no I/O', async () => {
  for (const change of [{ GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REPOSITORY: 'foreign/repo' },
    { CM_JIRA_TRANSITION_WRITER_ENABLED: 'false' }, { CM_JIRA_TRANSITION_WRITER_ENABLED: 'TRUE' },
    { CM_JIRA_WRITER_ACCOUNT_ID: '' }, { CM_JIRA_WRITER_ACCOUNT_ID: 'actor with spaces' },
    { CM_JIRA_ISSUE_KEY: 'OTHER-1' }, { CM_JIRA_DEFER_CONFIRMATION: 'yes' },
    { CM_JIRA_REGISTER_DATABASE_URL: env.CM_JIRA_REGISTER_DATABASE_URL.replace('verify-full', 'disable') }]) {
    const h = harness();
    assert.equal(await runJiraReadiness({ ...h.options, env: { ...env, ...change },
      poolFactory: () => assert.fail('must not connect') }), 1);
    assert.deepEqual(h.output, [failed]);
  }
});
test('register reconciliation precedes promotion and output contains no provider content', async () => {
  const h = harness(); const order = [];
  assert.equal(await runJiraReadiness({ ...h.options,
    publish: async options => { order.push('register'); assert.equal(options.pool, h.pool); return registered; },
    promote: async options => {
      order.push('transition'); assert.equal(options.actorId, 'test-writer');
      return { ...confirmed, privatePayload: 'must not log' };
    } }), 0);
  assert.deepEqual(order, ['register', 'transition']);
  assert.deepEqual(h.output, [confirmed]); assert.equal(h.closed(), true);
});
test('pending register work cannot be promoted', async () => {
  const h = harness();
  assert.equal(await runJiraReadiness({ ...h.options,
    publish: async () => ({ ...registered, result: 'JIRA_REGISTER_TASK_PENDING' }),
    promote: () => assert.fail('must not promote') }), 0);
  assert.deepEqual(h.output, [{ result: 'JIRA_READINESS_REGISTER_PENDING', transitionSubmitted: false,
    transitionConfirmed: false, atTarget: false }]);
});
test('broad database identity, provider errors, malformed receipts and cleanup failures never claim no write', async () => {
  for (const mode of ['identity', 'publish', 'promote', 'output', 'cleanup']) {
    const h = harness({ role: mode === 'identity' ? { ...identity, rolsuper: true } : identity,
      cleanupFailure: mode === 'cleanup' });
    assert.equal(await runJiraReadiness({ ...h.options,
      publish: async () => { if (mode === 'publish') throw new Error('private token'); return registered; },
      promote: async () => {
        if (mode === 'promote') throw new Error('private SQL after transition');
        return mode === 'output' ? { ...confirmed, result: 'unknown provider text' } : confirmed;
      } }), 1);
    assert.deepEqual(h.output, [failed]); assert.equal(h.closed(), true);
  }
});
test('idle connection errors cancel in-flight HTTP and prevent subsequent work', async () => {
  const h = harness(); let signal;
  assert.equal(await runJiraReadiness({ ...h.options,
    fetchImpl: async (_url, request) => { signal = request.signal; return new Response(null); },
    promote: async ({ fetchImpl }) => {
      await fetchImpl('https://api.atlassian.com', { signal: new AbortController().signal });
      h.idleError(); assert.equal(signal.aborted, true);
      assert.throws(() => fetchImpl('https://api.atlassian.com', { signal: new AbortController().signal }));
      return confirmed;
    } }), 1);
  assert.deepEqual(h.output, [failed]);
});
test('manual transition runner shares the publisher lock and injects secrets only after dependency installation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/jira-readiness-writer.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:|schedule:|workflow_run:|secrets: inherit/);
  assert.match(workflow, /environment: jira-readiness-writer/);
  assert.match(workflow, /group: jira-readiness-writer/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.ok(workflow.indexOf('CM_JIRA_WRITER_API_TOKEN:') > workflow.indexOf('run: npm ci'));
  for (const line of workflow.split('\n').filter(value => value.includes('uses:'))) assert.match(line, /@[a-f0-9]{40} /);
});

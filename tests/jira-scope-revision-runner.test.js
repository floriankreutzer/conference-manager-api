import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadJiraWriterConfig, runJiraPublisher } from '../scripts/jira-register-publish.mjs';
import { actorId, binding, execution, makeDecision } from './support/jira-scope-revision-fixture.mjs';

const proof = makeDecision();
const env = { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: execution.sourceSha, GITHUB_RUN_ID: execution.runId,
  GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR_ID: execution.githubActorId,
  CM_JIRA_REGISTER_WRITER_ENABLED: 'true', CM_JIRA_REGISTER_OPERATION: 'supersede',
  CM_JIRA_WRITER_ACCOUNT_ID: actorId, CM_JIRA_DECISION_COMMENT_ID: proof.commentId,
  CM_JIRA_DECISION_DIGEST: proof.decisionDigest,
  CM_JIRA_REGISTER_DATABASE_HOST: 'ep-test-example.eu-central-1.aws.neon.tech',
  CM_JIRA_REGISTER_DATABASE_URL: 'postgresql://cm_jira_register_writer:test-only@ep-test-example.eu-central-1.aws.neon.tech'
    + '/conference_manager_demo_shared?sslmode=verify-full',
  CM_JIRA_CLOUD_ID: binding.cloudId, CM_JIRA_WRITER_EMAIL: 'test@example.invalid',
  CM_JIRA_WRITER_API_TOKEN: 'test-only-jira-token', CM_GITHUB_INVENTORY_TOKEN: 'test-only-github-token',
  CM_JIRA_ISSUE_KEY: binding.issueKey };
const identity = { role_name: 'cm_jira_register_writer', database_name: 'conference_manager_demo_shared',
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, inherits_role: false };
const failed = { result: 'JIRA_REGISTER_RUN_UNVERIFIED', readinessAuthorized: false };

function harness(overrides = {}) {
  const output = [];
  let closed = false;
  const pool = { on: () => {}, query: async () => ({ rows: [identity] }), end: async () => { closed = true; } };
  return { pool, output, closed: () => closed, options: { env: { ...env, ...overrides },
    poolFactory: () => pool, write: value => output.push(JSON.parse(value)),
    publish: () => assert.fail('explicit revision must never select the automatic append path') } };
}

test('explicit revision reuses the qualified actor and immutable actual workflow execution context', async () => {
  const config = loadJiraWriterConfig(env);
  assert.equal(config.operation, 'supersede');
  assert.equal(config.publisher.actorId, actorId);
  assert.deepEqual(config.publisher.execution, execution);
  assert.deepEqual(config.database.ssl, { rejectUnauthorized: true });
  const fixture = harness();
  assert.equal(await runJiraPublisher({ ...fixture.options, revise: async options => {
    assert.equal(options.pool, fixture.pool);
    assert.equal(options.commentId, proof.commentId);
    assert.equal(options.expectedDecisionDigest, proof.decisionDigest);
    return { result: 'JIRA_SCOPE_REVISION_CONFIRMED', writeSubmitted: true, readinessAuthorized: false,
      privateDecision: proof.decisionText };
  } }), 0);
  assert.deepEqual(fixture.output, [{ result: 'JIRA_SCOPE_REVISION_CONFIRMED', writeSubmitted: true, readinessAuthorized: false }]);
  assert.equal(fixture.closed(), true);
});

for (const [name, change] of [
  ['missing writer identity', { CM_JIRA_WRITER_ACCOUNT_ID: undefined }],
  ['missing exact decision', { CM_JIRA_DECISION_COMMENT_ID: '' }],
  ['wrong digest', { CM_JIRA_DECISION_DIGEST: 'approved' }],
  ['implicit mode with a decision', { CM_JIRA_REGISTER_OPERATION: undefined }],
  ['unknown mode', { CM_JIRA_REGISTER_OPERATION: 'supporting' }],
  ['scheduled event', { GITHUB_EVENT_NAME: 'schedule' }],
  ['non-main source', { GITHUB_REF: 'refs/heads/feature' }],
  ['workflow rerun', { GITHUB_RUN_ATTEMPT: '2' }],
  ['missing immutable source', { GITHUB_SHA: undefined }],
  ['missing execution identity', { GITHUB_ACTOR_ID: undefined }],
  ['missing run identity', { GITHUB_RUN_ID: undefined }],
  ['invalid issue', { CM_JIRA_ISSUE_KEY: 'CO-296/other' }],
  ['unactivated writer', { CM_JIRA_REGISTER_WRITER_ENABLED: 'false' }],
]) {
  test(`revision runner rejects ${name} before any connection`, async () => {
    const output = [];
    assert.equal(await runJiraPublisher({ env: { ...env, ...change },
      poolFactory: () => assert.fail('invalid authority must not construct a pool'),
      publish: () => assert.fail('no fallback'), revise: () => assert.fail('no revision'),
      write: value => output.push(JSON.parse(value)) }), 1);
    assert.deepEqual(output, [failed]);
  });
}

test('revision failure cannot claim no write, leak a decision, or produce readiness authority', async () => {
  const fixture = harness();
  assert.equal(await runJiraPublisher({ ...fixture.options, revise: async () => {
    throw new Error('private decision and provider credentials after an uncertain write');
  } }), 1);
  assert.deepEqual(fixture.output, [failed]);
  assert.equal(fixture.closed(), true);
});

test('a result from the wrong operation cannot be reported as successful scope execution', async () => {
  const fixture = harness();
  assert.equal(await runJiraPublisher({ ...fixture.options, revise: async () => ({
    result: 'JIRA_REGISTER_CONFIRMED', writeSubmitted: true, readinessAuthorized: false,
  }) }), 1);
  assert.deepEqual(fixture.output, [failed]);
});

test('existing manual workflow exposes an explicit mode, not a new default or recurring revision path', async () => {
  const source = await readFile(new URL('../.github/workflows/jira-register-publish.yml', import.meta.url), 'utf8');
  assert.match(source, /default: append/);
  assert.match(source, /- supersede/);
  assert.match(source, /CM_JIRA_WRITER_ACCOUNT_ID: \$\{\{ vars\.CM_JIRA_WRITER_ACCOUNT_ID \}\}/);
  assert.match(source, /CM_JIRA_DECISION_DIGEST: \$\{\{ inputs\.decision_digest \}\}/);
  assert.doesNotMatch(source, /schedule:|workflow_run:|pull_request_target:|permission-contents: write/);
  assert.ok(source.indexOf('CM_JIRA_WRITER_ACCOUNT_ID:') > source.indexOf('run: npm ci --ignore-scripts'));
});

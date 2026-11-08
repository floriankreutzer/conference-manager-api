import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadJiraWriterConfig, runJiraPublisher } from '../scripts/jira-register-publish.mjs';

const env = { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', CM_JIRA_REGISTER_WRITER_ENABLED: 'true',
  CM_JIRA_REGISTER_DATABASE_HOST: 'ep-test-example.eu-central-1.aws.neon.tech',
  CM_JIRA_REGISTER_DATABASE_URL: 'postgresql://cm_jira_register_writer:test-only@ep-test-example.eu-central-1.aws.neon.tech'
    + '/conference_manager_demo_shared?sslmode=verify-full',
  CM_JIRA_CLOUD_ID: '11111111-1111-1111-1111-111111111111', CM_JIRA_WRITER_EMAIL: 'test@example.invalid',
  CM_JIRA_WRITER_API_TOKEN: 'test-only-jira-token', CM_GITHUB_INVENTORY_TOKEN: 'test-only-github-token',
  CM_JIRA_ISSUE_KEY: 'CO-296' };
const identity = { role_name: 'cm_jira_register_writer', database_name: 'conference_manager_demo_shared',
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, inherits_role: false };
const failed = { result: 'JIRA_REGISTER_RUN_UNVERIFIED', readinessAuthorized: false };

function harness({ role = identity, queryFailure = false, cleanupFailure = false } = {}) {
  let listener;
  let closed = false;
  const output = [];
  const pool = { on: (event, callback) => { assert.equal(event, 'error'); listener = callback; },
    query: async () => { if (queryFailure) throw new Error('private SQL connection'); return { rows: [role] }; },
    end: async () => { closed = true; if (cleanupFailure) throw new Error('private cleanup payload'); } };
  return { pool, output, options: { env, poolFactory: () => pool, write: value => output.push(JSON.parse(value)) },
    idleError: () => listener(new Error('private connection string')), closed: () => closed };
}

test('writer configuration pins target identity, verified TLS and bounded dedicated pool', () => {
  const config = loadJiraWriterConfig(env);
  assert.deepEqual(config.database.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(config.database.connectionString).search, '');
  assert.equal(config.database.max, 2);
  assert.equal(config.database.connectionTimeoutMillis, 5000);
  assert.equal(config.database.statement_timeout, 5000);
  assert.equal(config.database.query_timeout, 6000);
  assert.equal(config.publisher.token, env.CM_JIRA_WRITER_API_TOKEN);
  assert.equal(config.publisher.issueKey, 'CO-296');
});

test('writer accepts a pinned Neon cell endpoint with verified TLS', () => {
  const host = 'ep-test-example.c-5.eu-central-1.aws.neon.tech';
  const candidate = { ...env, CM_JIRA_REGISTER_DATABASE_HOST: host,
    CM_JIRA_REGISTER_DATABASE_URL: env.CM_JIRA_REGISTER_DATABASE_URL
      .replace(env.CM_JIRA_REGISTER_DATABASE_HOST, host) };
  const config = loadJiraWriterConfig(candidate);
  assert.equal(new URL(config.database.connectionString).hostname, host);
  assert.deepEqual(config.database.ssl, { rejectUnauthorized: true });
  assert.throws(() => loadJiraWriterConfig({ ...candidate,
    CM_JIRA_REGISTER_DATABASE_HOST: host.replace('c-5', 'c-6') }), /JIRA_REGISTER_RUN_UNVERIFIED/);
});

test('invalid Neon cell or foreign authority fails before any connection', async () => {
  for (const host of ['ep-test.c-x.eu-central-1.aws.neon.tech',
    'ep-test.c-5.c-6.eu-central-1.aws.neon.tech', 'ep-test.c-5.eu-central-1.aws.neon.tech.evil.test',
    'ep-test.c-5.eu-central-1.aws.neon.tech.', '127.0.0.1',
    `ep-${'a'.repeat(240)}.c-5.eu-central-1.aws.neon.tech`]) {
    const output = [];
    assert.equal(await runJiraPublisher({ env: { ...env, CM_JIRA_REGISTER_DATABASE_HOST: host,
      CM_JIRA_REGISTER_DATABASE_URL: env.CM_JIRA_REGISTER_DATABASE_URL
        .replace(env.CM_JIRA_REGISTER_DATABASE_HOST, host) },
    poolFactory: () => assert.fail('unexpected pool'), publish: () => assert.fail('unexpected publish'),
    write: value => output.push(JSON.parse(value)) }), 1);
    assert.deepEqual(output, [failed]);
  }
});

for (const change of [
  { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_REF: 'refs/pull/1/merge' },
  { GITHUB_EVENT_NAME: 'pull_request_target' }, { CM_JIRA_REGISTER_WRITER_ENABLED: '' },
  { CM_JIRA_REGISTER_WRITER_ENABLED: 'TRUE' }, { CM_JIRA_REGISTER_DATABASE_HOST: 'example.com' },
  ...['postgres:', 'https:'].map(protocol => ({
    CM_JIRA_REGISTER_DATABASE_URL: env.CM_JIRA_REGISTER_DATABASE_URL.replace('postgresql:', protocol) })),
  ...[
    ['cm_jira_register_writer:', 'neondb_owner:'], ['test-only@', '@'],
    ['ep-test-example.', 'ep-foreign-example.'], ['conference_manager_demo_shared?', 'other?'],
    ['sslmode=verify-full', 'sslmode=require'], ['sslmode=verify-full', 'sslmode=verify-full&sslmode=disable'],
    ['sslmode=verify-full', 'sslmode=verify-full&sslrootcert=/tmp/private'],
    ['sslmode=verify-full', 'sslmode=verify-full#fragment'],
    ['.tech/', '.tech:5433/'],
  ].map(([before, after]) => ({ CM_JIRA_REGISTER_DATABASE_URL: env.CM_JIRA_REGISTER_DATABASE_URL.replace(before, after) })),
]) {
  test(`invalid runner configuration performs no I/O: ${JSON.stringify(change)}`, async () => {
    const output = [];
    assert.equal(await runJiraPublisher({ env: { ...env, ...change },
      poolFactory: () => assert.fail('unexpected pool'), publish: () => assert.fail('unexpected publisher'),
      write: value => output.push(JSON.parse(value)) }), 1);
    assert.deepEqual(output, [failed]);
  });
}

for (const role of [{ ...identity, role_name: 'neondb_owner' }, { ...identity, database_name: 'other' },
  ...['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls', 'inherits_role'].map(key => ({ ...identity, [key]: true })),
  { ...identity, rolsuper: undefined }]) {
  test(`rejects broad or uncertain database identity: ${JSON.stringify(role)}`, async () => {
    const mock = harness({ role });
    assert.equal(await runJiraPublisher({ ...mock.options, publish: () => assert.fail('unexpected publish') }), 1);
    assert.deepEqual(mock.output, [failed]);
    assert.equal(mock.closed(), true);
  });
}

for (const result of ['JIRA_REGISTER_CONFIRMED', 'JIRA_REGISTER_TASK_PENDING', 'JIRA_REGISTER_UNCHANGED',
  'JIRA_REGISTER_ISSUE_NOT_IN_REVIEW']) {
  test(`reports bounded publisher outcome ${result} without readiness authority`, async () => {
    const mock = harness();
    assert.equal(await runJiraPublisher({ ...mock.options, publish: async options => {
      assert.equal(options.pool, mock.pool);
      assert.equal(options.token, env.CM_JIRA_WRITER_API_TOKEN);
      return { result, writeSubmitted: true, readinessAuthorized: false, privatePayload: 'never log this' };
    } }), 0);
    assert.deepEqual(mock.output, [{ result, writeSubmitted: true, readinessAuthorized: false }]);
    assert.equal(mock.closed(), true);
  });
}

test('query, publisher and cleanup failures stay redacted without a false no-write claim', async () => {
  for (const options of [{ queryFailure: true }, { cleanupFailure: true }, {}]) {
    const mock = harness(options);
    assert.equal(await runJiraPublisher({ ...mock.options, publish: async () => {
      if (!options.cleanupFailure) throw new Error('private provider token');
      return { result: 'JIRA_REGISTER_CONFIRMED', writeSubmitted: true, readinessAuthorized: false };
    } }), 1);
    assert.deepEqual(mock.output, [failed]);
    assert.equal(mock.closed(), true);
  }
});

test('idle pool errors abort outbound requests and prevent later submission or success', async () => {
  const mock = harness();
  let signal;
  assert.equal(await runJiraPublisher({ ...mock.options,
    fetchImpl: async (_url, options) => { signal = options.signal; return new Response(null); },
    publish: async ({ fetchImpl }) => {
      const options = { signal: new AbortController().signal };
      await fetchImpl('https://api.atlassian.com', options);
      mock.idleError();
      assert.equal(signal.aborted, true);
      assert.throws(() => fetchImpl('https://api.atlassian.com', options), /JIRA_REGISTER_RUN_UNVERIFIED/);
      return { result: 'JIRA_REGISTER_CONFIRMED', writeSubmitted: true, readinessAuthorized: false };
    } }), 1);
  assert.deepEqual(mock.output, [failed]);
});

test('unknown publisher output and output sink failure cannot return success', async () => {
  for (const result of [{ result: 'private payload', writeSubmitted: true, readinessAuthorized: false },
    { result: 'JIRA_REGISTER_CONFIRMED', writeSubmitted: true, readinessAuthorized: true }]) {
    const mock = harness();
    assert.equal(await runJiraPublisher({ ...mock.options, publish: async () => result }), 1);
    assert.deepEqual(mock.output, [failed]);
  }
  const mock = harness();
  assert.equal(await runJiraPublisher({ ...mock.options, publish: async () => ({
    result: 'JIRA_REGISTER_UNCHANGED', writeSubmitted: false, readinessAuthorized: false }),
  write: () => { throw new Error('broken output'); } }), 1);
});

test('writer workflow is main-only, manual and environment-bound with late secret injection', async () => {
  const workflow = await readFile(new URL('../.github/workflows/jira-register-publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:|schedule:|workflow_run:|secrets: inherit/);
  assert.match(workflow, /environment: jira-readiness-writer/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow, /CM_JIRA_READINESS_API_TOKEN|DATABASE_URL: \$\{\{ secrets\.DATABASE_URL/);
  for (const line of workflow.split('\n').filter(value => value.includes('uses:'))) {
    assert.match(line, /@[a-f0-9]{40} /);
  }
  assert.ok(workflow.indexOf('CM_JIRA_WRITER_API_TOKEN:') > workflow.indexOf('run: npm ci'));
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runJiraReadinessSweep, loadJiraSweepConfig } from '../scripts/jira-readiness-sweep.mjs';
import { reconcileJiraReadinessIssue } from '../scripts/jira-readiness-write.mjs';
import { observeJiraReadyTransition } from '../scripts/jira-transition-transport.mjs';
import { fixture, transport } from './support/jira-readiness-fixture.mjs';

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
const registered = { result: 'JIRA_REGISTER_UNCHANGED', readinessAuthorized: false };
const observation = { phase: 'history', outcome: 'unverified', requests: 2, entries: 1, elapsedMs: 15000 };
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
  assert.deepEqual(h.output[0].receipts, [{ issueKey: 'CO-1', result: 'JIRA_READINESS_RUN_UNVERIFIED', failurePhase: 'reconciliation' },
    { issueKey: 'CO-2', ...receipt }]);
  assert.equal(h.output[0].result, 'JIRA_READINESS_SWEEP_PARTIAL');
});
test('shared composition identifies the failing register or promotion without inferring a write outcome', async () => {
  const matched = { ...observation, phase: 'complete', outcome: 'matched' };
  for (const stage of ['register', 'promotion']) {
    const h = harness(); const promoted = [];
    assert.equal(await runJiraReadinessSweep({ ...h.options, execute: options => reconcileJiraReadinessIssue(options, {
      publish: async ({ issueKey }) => {
        if (issueKey === 'CO-1' && stage === 'register') throw new Error('private register payload');
        return registered;
      },
      promote: async ({ issueKey, onHistoryObservation }) => {
        promoted.push(issueKey);
        if (issueKey === 'CO-1') { onHistoryObservation(matched); throw new Error('private journal failure after POST'); }
        return receipt;
      },
    }) }), 1);
    assert.deepEqual(h.output[0].receipts, [{ issueKey: 'CO-1', result: 'JIRA_READINESS_RUN_UNVERIFIED', failurePhase: stage,
      ...(stage === 'promotion' ? { historyObservation: matched } : {}) }, { issueKey: 'CO-2', ...receipt }]);
    assert.deepEqual(promoted, stage === 'register' ? ['CO-2'] : ['CO-1', 'CO-2']);
    assert.equal(h.output[0].result, 'JIRA_READINESS_SWEEP_PARTIAL');
  }
});
test('completed and pending receipts retain a validated history snapshot only for their own issue', async () => {
  for (const confirmed of [false, true]) {
    const h = harness();
    const result = { result: confirmed ? 'JIRA_READINESS_TRANSITION_CONFIRMED' : 'JIRA_READINESS_TRANSITION_PENDING',
      transitionSubmitted: confirmed, transitionConfirmed: confirmed, atTarget: confirmed };
    const expected = { ...observation, phase: 'complete', outcome: confirmed ? 'matched' : 'missing' };
    assert.equal(await runJiraReadinessSweep({ ...h.options, execute: options => reconcileJiraReadinessIssue(options, {
      publish: async () => registered,
      promote: async ({ issueKey, onHistoryObservation }) => {
        if (issueKey !== 'CO-1') return receipt;
        const value = { ...expected }; onHistoryObservation(value);
        value.phase = 'private mutation'; value.payload = 'private token';
        return result;
      },
    }) }), 0);
    assert.deepEqual(h.output[0], { result: 'JIRA_READINESS_SWEEP_COMPLETED', queueSize: 2, selected: 2,
      receipts: [{ issueKey: 'CO-1', ...result, historyObservation: expected }, { issueKey: 'CO-2', ...receipt }] });
  }
});
test('unknown diagnostic fields, unbounded values and private phases fail closed and stay out of receipts', async () => {
  for (const value of [null, [], {}, { ...observation, payload: 'private token' },
    { ...observation, phase: 'private phase' }, { ...observation, outcome: 'private response' },
    { ...observation, requests: 101 }, { ...observation, requests: -1 }, { ...observation, entries: 1001 },
    { ...observation, entries: 0.5 }, { ...observation, elapsedMs: NaN }, { ...observation, elapsedMs: Infinity },
    { ...observation, elapsedMs: -1 }, { ...observation, elapsedMs: 240001 }]) {
    const h = harness();
    assert.equal(await runJiraReadinessSweep({ ...h.options, execute: async ({ issueKey, onHistoryObservation }) => {
      if (issueKey === 'CO-1') { onHistoryObservation(observation); onHistoryObservation(value); }
      return receipt;
    } }), 1);
    assert.deepEqual(h.output[0].receipts, [{ issueKey: 'CO-1', result: 'JIRA_READINESS_RUN_UNVERIFIED', failurePhase: 'diagnostic' },
      { issueKey: 'CO-2', ...receipt }]);
  }
  const h = harness();
  assert.equal(await runJiraReadinessSweep({ ...h.options, execute: async ({ issueKey, onReadinessPhase }) => {
    if (issueKey === 'CO-1') onReadinessPhase('private exception');
    return receipt;
  } }), 1);
  assert.deepEqual(h.output[0].receipts, [{ issueKey: 'CO-1', result: 'JIRA_READINESS_RUN_UNVERIFIED', failurePhase: 'diagnostic' },
    { issueKey: 'CO-2', ...receipt }]);
});
test('bounded history failure reaches the sweep through the shared composition without replaying a transition', async () => {
  const h = harness(); const f = fixture('CO-1'); const provider = transport(f);
  f.histories = [{ id: '99', items: [{ field: 'description', toString: 'private content'.repeat(20000) }] }];
  const attempt = { state: 'pending', attemptId: '11111111-1111-1111-1111-111111111111',
    decisionKey: 'a'.repeat(64), registerDigest: 'b'.repeat(64), actorId: f.options.actorId,
    transitionId: '2', sourceStatusId: '10004', targetStatusId: '10009', createdAt: new Date().toISOString() };
  assert.equal(await runJiraReadinessSweep({ ...h.options,
    env: { ...env, CM_JIRA_CLOUD_ID: f.options.cloudId, CM_JIRA_WRITER_ACCOUNT_ID: f.options.actorId,
      CM_JIRA_WRITER_EMAIL: f.options.email, CM_JIRA_WRITER_API_TOKEN: f.options.token }, fetchImpl: provider.fetchImpl,
    execute: options => reconcileJiraReadinessIssue(options, {
      publish: async () => registered,
      promote: async current => {
        if (current.issueKey === 'CO-1') {
          await observeJiraReadyTransition({ ...current, issueId: f.issue.id, attempt });
          assert.fail('oversized history cannot be verified');
        }
        return receipt;
      },
    }),
  }), 1);
  const historyObservation = h.output[0].receipts[0].historyObservation;
  assert.deepEqual(h.output[0].receipts, [{ issueKey: 'CO-1', result: 'JIRA_READINESS_RUN_UNVERIFIED',
    failurePhase: 'promotion', historyObservation: { phase: 'history', outcome: 'unverified', requests: 7, entries: 0,
      elapsedMs: historyObservation.elapsedMs } }, { issueKey: 'CO-2', ...receipt }]);
  assert.ok(Number.isSafeInteger(historyObservation.elapsedMs) && historyObservation.elapsedMs >= 0
    && historyObservation.elapsedMs <= 240000);
  const pages = provider.calls.filter(call => call.url.includes('/changelog?'));
  assert.deepEqual(pages.map(call => new URL(call.url).searchParams.get('maxResults')), ['100', '50', '25', '12', '6', '3', '1']);
  assert.ok(pages.every(call => new URL(call.url).searchParams.get('startAt') === '0'));
  assert.ok(provider.calls.every(call => call.init.method === 'GET'));
  assert.equal(f.posts, 0); assert.equal(h.closed(), true);
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
  assert.deepEqual(h.output[0].receipts, ['CO-1', 'CO-2'].map(issueKey => ({ issueKey,
    result: 'JIRA_READINESS_RUN_UNVERIFIED', failurePhase: 'receipt' })));
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

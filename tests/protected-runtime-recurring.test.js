import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { requireRecurringRuntimeObservationContext, recurringRuntimeObservationWindow,
  readRecurringRuntimeObservationSelection, RECURRING_OBSERVATION_CRON }
  from '../scripts/support/protected-runtime-recurring-context.mjs';
import { normalizeRuntimeObservationSelection } from '../scripts/support/protected-runtime-observation-plan.mjs';
import { protectedRuntimeObservationDatabase } from '../scripts/support/protected-runtime-observation-execution.mjs';

const source = 'b'.repeat(40);
function context(event = 'schedule') {
  return { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'floriankreutzer', GITHUB_TRIGGERING_ACTOR: 'floriankreutzer', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: source, QUALIFIED_OBSERVER_SHA: source, OBSERVATION_REPOSITORY_PRIVATE: 'false',
    GITHUB_WORKFLOW_REF: 'floriankreutzer/conference-manager-api/.github/workflows/protected-int-runtime-recurring.yml@refs/heads/main',
    GITHUB_EVENT_NAME: event, OBSERVATION_SCHEDULE: RECURRING_OBSERVATION_CRON,
    OBSERVATION_SCHEDULE_ENABLED: 'true', EXPECTED_MAIN_SHA: source };
}

test('recurring observation accepts only exact qualified public owner Main and explicit event authority', () => {
  assert.doesNotThrow(() => requireRecurringRuntimeObservationContext(context()));
  assert.doesNotThrow(() => requireRecurringRuntimeObservationContext(context('workflow_dispatch')));
  for (const delta of [{ GITHUB_REPOSITORY: 'foreign/conference-manager-api' }, { GITHUB_REF: 'refs/heads/candidate' },
    { GITHUB_ACTOR: 'foreign' }, { GITHUB_TRIGGERING_ACTOR: 'foreign' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_SHA: 'main' }, { GITHUB_SHA: 'c'.repeat(40) }, { QUALIFIED_OBSERVER_SHA: '' },
    { OBSERVATION_REPOSITORY_PRIVATE: 'true' }, { OBSERVATION_REPOSITORY_PRIVATE: undefined },
    { GITHUB_WORKFLOW_REF: context().GITHUB_WORKFLOW_REF.replace('@refs/heads/main', '@refs/heads/candidate') },
    { GITHUB_EVENT_NAME: 'pull_request_target' }, { OBSERVATION_SCHEDULE: '* * * * *' },
    { OBSERVATION_SCHEDULE_ENABLED: undefined }, { OBSERVATION_SCHEDULE_ENABLED: 'false' },
    { OBSERVATION_SCHEDULE_ENABLED: 'yes' },
    { RUNNER_DEBUG: '1' }, { ACTIONS_STEP_DEBUG: 'true' }, { ACTIONS_RUNNER_DEBUG: 'true' }, { NODE_OPTIONS: '--inspect' }]) {
    assert.throws(() => requireRecurringRuntimeObservationContext({ ...context(), ...delta }), /OBSERVATION_REFUSED/);
  }
  assert.throws(() => requireRecurringRuntimeObservationContext({ ...context('workflow_dispatch'),
    EXPECTED_MAIN_SHA: 'c'.repeat(40) }), /OBSERVATION_REFUSED/);
});

test('a qualified bounded manual observation does not enable recurring traffic', () => {
  for (const enabled of [undefined, '', 'false']) {
    assert.doesNotThrow(() => requireRecurringRuntimeObservationContext({
      ...context('workflow_dispatch'), OBSERVATION_SCHEDULE_ENABLED: enabled,
    }));
  }
});

test('daily local window preserves exact boundaries across winter, summer and DST changes', () => {
  for (const date of ['2026-01-15', '2026-03-29', '2026-07-15', '2026-10-25']) {
    const summer = date === '2026-03-29' || date === '2026-07-15';
    const hour = summer ? 7 : 8;
    const start = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
    assert.equal(recurringRuntimeObservationWindow(start - 1), false);
    assert.equal(recurringRuntimeObservationWindow(start), true);
    assert.equal(recurringRuntimeObservationWindow(start + 36_000_000 - 1), true);
    assert.equal(recurringRuntimeObservationWindow(start + 36_000_000), false);
  }
  for (const invalid of [NaN, Infinity, -1, 0.1, '2026-01-15', 8_640_000_000_000_001]) {
    assert.throws(() => recurringRuntimeObservationWindow(invalid), /OBSERVATION_REFUSED/);
  }
});

test('fixed reviewed deployments remain independent from qualified observer source; no invented optional evidence', async () => {
  const selection = await readRecurringRuntimeObservationSelection();
  const deployedSource = 'ca1f06b5b5181965f7c3aeffdc235aa44c638771';
  assert.equal(selection.environment, 'int');
  assert.equal(selection.apiCommit, deployedSource);
  assert.notEqual(selection.apiCommit, source);
  assert.equal(selection.frontendCommit, '2ddcf3859505fe62a46ac008fb1d6e9059711bbb');
  assert.notEqual(selection.customer.deploymentReference, selection.platform.deploymentReference);
  assert.equal(selection.evidence.rollback, null);assert.ok(Object.isFrozen(selection));
});

test('the released frontend is required by both selection validation and the credential-free checkout', async () => {
  const selection = await readRecurringRuntimeObservationSelection();
  assert.doesNotThrow(() => normalizeRuntimeObservationSelection(selection));
  for (const frontendCommit of ['2667b0b6df74ffa2632fce4be6f95ef8ef8103ac', 'f6359ff537165c5e29fc4884578d92a83ce22be4', 'a'.repeat(40)]) {
    assert.throws(() => normalizeRuntimeObservationSelection({ ...selection, frontendCommit }), /OBSERVATION_REFUSED/);
  }
  const workflow = await readFile('.github/workflows/protected-int-runtime-recurring.yml', 'utf8');
  assert.ok(workflow.includes(`ref: '${selection.frontendCommit}'`));
});

test('shared CLI credential binding rejects foreign database, runtime identity and malformed role before collection', () => {
  const env = { PLATFORM_PASSKEY_OFFLINE_ROLE: 'fixture_offline',
    PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: 'postgresql://fixture_offline:fixture@db.example.test/demo',
    PLATFORM_DATABASE_URL: 'postgresql://fixture_runtime:fixture@db.example.test/demo' };
  assert.equal(protectedRuntimeObservationDatabase(env).expectedOfflineRole, 'fixture_offline');
  for (const delta of [{ PLATFORM_PASSKEY_OFFLINE_ROLE: 'cm_protected_int_platform' },
    { PLATFORM_PASSKEY_OFFLINE_ROLE: 'foreign_owner' }, { PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: 'invalid' },
    { PLATFORM_DATABASE_URL: env.PLATFORM_PASSKEY_OFFLINE_DATABASE_URL },
    { PLATFORM_DATABASE_URL: env.PLATFORM_DATABASE_URL.replace('/demo', '/foreign') },
    { PLATFORM_DATABASE_URL: env.PLATFORM_DATABASE_URL.replace('db.example.test', 'foreign.example.test') },
    { PLATFORM_DATABASE_URL: env.PLATFORM_DATABASE_URL.replace('postgresql:', 'https:') }]) {
    assert.throws(() => protectedRuntimeObservationDatabase({ ...env, ...delta }), /OBSERVATION_REFUSED/);
  }
});

test('recurring workflow retains shared exclusion, pinned sources, late minimal credentials and no private runner execution', async () => {
  const workflow = await readFile('.github/workflows/protected-int-runtime-recurring.yml', 'utf8');
  assert.ok(workflow.includes(`cron: '${RECURRING_OBSERVATION_CRON}'`));
  assert.equal(RECURRING_OBSERVATION_CRON, '2-57/5 7-17 * * *');
  assert.match(workflow, /github.event.repository.private == false/);
  assert.match(workflow, /vars.CM_INT_OBSERVER_QUALIFIED_SHA == github.sha/);
  assert.match(workflow, /github.event_name == 'schedule' && vars.CM_INT_OBSERVER_SCHEDULE_ENABLED == 'true'/);
  assert.match(workflow, /group: hosted-shared-demo-database-initialize/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /github.run_attempt == 1/);
  assert.match(workflow, /inputs.expected_main_sha == github.sha/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request_target:|contents: write|CM_INT_AUDIT_HMAC_SECRET|selection_json|NODE_OPTIONS:/);
  assert.equal((workflow.match(/CM_INT_AUDIT_OFFLINE_DATABASE_URL/g) ?? []).length, 1);
  assert.ok(workflow.indexOf('CM_INT_AUDIT_OFFLINE_DATABASE_URL') > workflow.indexOf('protected-runtime-recurring-build.mjs'));
  assert.match(workflow, /git diff --exit-code HEAD/);
});

test('actual CLI preflight needs no database binding; wrong source and extra arguments fail with minimized errors', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const env = { PATH: process.env.PATH, ...context('workflow_dispatch'),
    GITHUB_SHA: head, EXPECTED_MAIN_SHA: head, QUALIFIED_OBSERVER_SHA: head };
  const run = (script, args = [], delta = {}) => spawnSync(process.execPath, [script, ...args], {
    env: { ...env, ...delta }, encoding: 'utf8', timeout: 10000,
  });
  const ready = run('scripts/protected-runtime-recurring-preflight.mjs');
  assert.equal(ready.status, 0);assert.equal(ready.stdout, 'active=true\n');assert.equal(ready.stderr, '');
  for (const result of [run('scripts/protected-runtime-recurring-preflight.mjs', ['foreign.json']),
    run('scripts/protected-runtime-recurring-preflight.mjs', [], { GITHUB_SHA: source, EXPECTED_MAIN_SHA: source,
      QUALIFIED_OBSERVER_SHA: source }),
    run('scripts/protected-runtime-recurring-observe.mjs', [], { QUALIFIED_OBSERVER_SHA: '' }),
    run('scripts/protected-runtime-recurring-build.mjs', [], { OBSERVATION_REPOSITORY_PRIVATE: 'true' })]) {
    assert.equal(result.status, 1);assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'PROTECTED_RUNTIME_OBSERVATION_REFUSED\n');
  }
});

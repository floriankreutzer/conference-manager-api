import assert from 'node:assert/strict';
import test from 'node:test';
import { compileRuntimeProductReport } from '../src/observability/product-runtime-report.js';
import { normalizeRuntimeProductReport } from '../src/observability/product-runtime-contract.js';
import { platformProductFacts } from '../src/persistence/postgres/platform-product-runtime-facts.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = '2026-10-18T13:00:00.000Z';
const at = (time) => `2026-10-18T${time}:00.000Z`;
const metric = (report, id) => report.product.find((item) => item.id === id);
const coverage = (report, id) => report.productCoverage.find((item) => item.id === id);

function fixture() {
  let id = 0;
  const event = (action, request, time, before, after, extra = {}) => ({
    id: String(++id), tenantId: TENANT, action, targetType: 'request', targetId: request,
    previousState: before === null ? null : { status: before }, newState: { status: after },
    occurredAt: at(time), outcome: 'success', metadata: {}, eventHash: String(id).padStart(64, '0'), ...extra,
  });
  return { observedAt: NOW, sourceEpoch: EPOCH, epochStartedAt: at('12:55'),
    tenant: { state: 'available', events: [
      event('tenant.identity.claimed', TENANT, '08:00', null, 'active',
        { targetType: 'tenant_identity', metadata: { onboardingStarted: true } }),
      event('request.created', 'legacy', '09:00', null, 'Submitted'),
      event('request.started', 'flow-a', '10:00', null, 'started'),
      event('request.created', 'flow-a', '10:05', null, 'Submitted'),
      event('request.transition', 'flow-a', '10:10', 'Submitted', 'Change Requested'),
      event('request.transition', 'flow-a', '10:15', 'Change Requested', 'Submitted'),
      event('request.transition', 'flow-a', '10:20', 'Submitted', 'Confirmed'),
      event('request.started', 'flow-b', '10:01', null, 'started'),
      event('request.abandoned', 'flow-b', '10:02', 'started', 'abandoned'),
      event('request.transition_failed', 'flow-b', '10:03', 'Submitted', 'Confirmed', { outcome: 'failure' }),
    ] },
    platform: { state: 'available', events: [
      { kind: 'onboarding_completed', occurredAt: at('08:05'), tenantId: TENANT, targetId: TENANT, identity: ['platform', 1] },
      { kind: 'recovery_completed', occurredAt: at('11:00'), tenantId: TENANT, targetId: TENANT, identity: ['platform', 2] },
      { kind: 'recovery_failed', occurredAt: at('11:05'), tenantId: TENANT, targetId: TENANT, identity: ['platform', 3] },
    ] },
    revisions: { state: 'available', rows: [
      { tenantId: TENANT, requestId: 'flow-a', version: 2, operation: 'transitioned', capturedAt: at('10:10'),
        roleAtAction: 'conference_manager', requestStatus: 'Change Requested' },
      { tenantId: TENANT, requestId: 'flow-a', version: 4, operation: 'transitioned', capturedAt: at('10:20'),
        roleAtAction: 'conference_manager', requestStatus: 'Confirmed' },
    ] },
  };
}

test('retained pre-activation events produce partial counts and first-submit/decision durations without identities', () => {
  const report = compileRuntimeProductReport(fixture());
  assert.deepEqual(report.product.map((item) => item.value), [1, 1, 2, 3, 1, 300000, 2, 300000, 1, 1, 1, 0.5]);
  assert.equal(report.periodEnd, NOW);
  assert.equal(report.periodStart, '2026-09-20T13:00:00.000Z');
  assert.ok(report.productCoverage.every((item) => item.state === 'partial'));
  assert.equal(coverage(report, 'time_to_submit').reason, 'missing_start_clock');
  assert.equal(report.provenance.eventCount, 13);
  assert.equal(report.collectionMode, 'runtime_projection');
  assert.equal(report.provenance.mode, 'retained_runtime');
  for (const privateValue of [TENANT, EPOCH, 'flow-a', 'flow-b', 'legacy']) {
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
  assert.equal(Object.hasOwn(report, 'delivery'), false);
  assert.equal(Object.hasOwn(report, 'feedback'), false);
});

test('one failed source leaves independently verified groups available and full failure cannot become a fresh report', () => {
  const input = fixture();
  input.tenant = { state: 'not_collected', reason: 'integrity_failure' };
  const report = compileRuntimeProductReport(input);
  assert.deepEqual(metric(report, 'request_submitted'),
    { id: 'request_submitted', unit: 'count', value: null, reason: 'integrity_failure' });
  assert.deepEqual(coverage(report, 'request_submitted'), { id: 'request_submitted', state: 'not_collected',
    reason: 'integrity_failure', sourcePeriodStart: null, sourcePeriodEnd: null });
  assert.equal(metric(report, 'onboarding_completed').value, 1);
  assert.equal(metric(report, 'recovery_failure_rate').value, 0.5);
  input.platform = { state: 'not_collected', reason: 'source_unavailable' };
  assert.throws(() => compileRuntimeProductReport(input), /PRODUCT_RUNTIME_SOURCE_UNAVAILABLE/);
});

test('missing role evidence limits only manager metrics and preserves an attributable subset', () => {
  const input = fixture();
  input.revisions.rows.pop();
  const partial = compileRuntimeProductReport(input);
  assert.equal(metric(partial, 'request_submitted').value, 3);
  assert.equal(metric(partial, 'manager_decisions').value, 1);
  assert.equal(coverage(partial, 'manager_decisions').reason, 'missing_attribution');
  input.revisions.rows = [];
  const absent = compileRuntimeProductReport(input);
  assert.equal(metric(absent, 'manager_decisions').value, null);
  assert.equal(metric(absent, 'manager_decisions').reason, 'missing_attribution');
  input.revisions = { state: 'not_collected', reason: 'source_unavailable' };
  const unavailable = compileRuntimeProductReport(input);
  assert.equal(metric(unavailable, 'request_submitted').value, 3);
  assert.equal(coverage(unavailable, 'manager_decisions').state, 'not_collected');
});

test('empty verified scope has known zero counts; durations keep an empty denominator and start coverage stays partial', () => {
  const input = fixture();
  input.epochStartedAt = '2026-09-01T00:00:00.000Z';
  input.tenant.events = []; input.platform.events = []; input.revisions.rows = [];
  const report = compileRuntimeProductReport(input);
  assert.equal(metric(report, 'request_submitted').value, 0);
  assert.equal(coverage(report, 'request_submitted').state, 'complete');
  assert.equal(coverage(report, 'request_started').state, 'partial');
  assert.equal(metric(report, 'time_to_submit').value, null);
  assert.equal(metric(report, 'time_to_submit').reason, 'empty_denominator');
  assert.equal(metric(report, 'recovery_failure_rate').reason, 'empty_denominator');
});

test('only executed canonical tenant recovery operations and onboarding-to-ready transitions become platform facts', () => {
  const event = { sequence: 1, targetTenantId: TENANT, targetId: TENANT, occurredAt: at('12:00'), eventHash: 'a'.repeat(64),
    action: 'platform.recovery.executed', targetType: 'tenant_recovery', outcome: 'success',
    previousState: null, newState: null, metadata: { operation: 'tenant.recovery.tenant_sessions' } };
  assert.equal(platformProductFacts([event]).length, 1);
  for (const change of [{ action: 'platform.recovery.previewed' }, { outcome: 'denied' }, { targetTenantId: null },
    { metadata: { operation: 'not_a_canonical_operation' } }, { targetType: 'tenant' }]) {
    assert.deepEqual(platformProductFacts([{ ...event, ...change }]), []);
  }
});

test('runtime wire rejects mixed clocks, hidden fields and falsely complete or unavailable numeric coverage', () => {
  const valid = compileRuntimeProductReport(fixture());
  for (const mutate of [
    (value) => { value.delivery = []; },
    (value) => { value.periodEnd = '2026-10-18T00:00:00.000Z'; },
    (value) => { value.observedAt = '2026-10-19T13:00:00.000Z'; },
    (value) => { value.productCoverage[0].state = 'complete'; },
    (value) => { value.productCoverage[0].state = 'not_collected'; },
    (value) => { value.provenance.sourceEpoch = null; },
    (value) => { value.provenance.sourceDigest = { toString: () => 'a'.repeat(64) }; },
  ]) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => normalizeRuntimeProductReport(value));
  }
});


test('protected runtime aggregates preserve real/synthetic provenance and cannot cross Demo authority', () => {
  const input = { ...fixture(), environment: 'production', accessMode: 'application_passkey',
    sourceContext: { runtimeEnvironment: 'int', dataProfile: 'synthetic', securityEpochDigest: 'a'.repeat(64) } };
  const report = compileRuntimeProductReport(input);
  assert.deepEqual(report.product.map(item => item.value), [1,1,2,3,1,300000,2,300000,1,1,1,0.5]);
  assert.equal(report.sourceContext.dataProfile, 'synthetic');
  assert.throws(() => normalizeRuntimeProductReport(report));
  assert.deepEqual(normalizeRuntimeProductReport(report, { environment: 'production', accessMode: 'application_passkey' }), report);
  for (const mutation of [value => { value.sourceContext.dataProfile = 'pilot'; },
    value => { value.sourceContext.runtimeEnvironment = 'prod'; }, value => { delete value.sourceContext.securityEpochDigest; },
    value => { value.sourceContext.tenantId = TENANT; }, value => { value.accessMode = 'shared_owner_password'; }]) {
    const invalid = structuredClone(report);mutation(invalid);
    assert.throws(() => normalizeRuntimeProductReport(invalid, { environment: 'production', accessMode: 'application_passkey' }));
  }
});

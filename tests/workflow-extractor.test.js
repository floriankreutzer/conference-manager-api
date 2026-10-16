import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowExtractor } from '../scripts/support/workflow-extractor.mjs';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CORRELATION = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const AT = '2026-10-02T10:00:00.000Z';
const principal = { userId: USER, tenantId: TENANT,
  ...tenantAuthorizationSnapshot(['tenant_admin', 'conference_manager']) };
const context = { tenantId: TENANT, status: 'active' };
const values = { principal, tenantContext: context, correlationId: CORRELATION };

function platformPrincipal() {
  const roles = [PLATFORM_ROLE.SECURITY_AUDITOR];
  return { operatorId: USER, roles, permissions: permissionsForPlatformRoles(roles), securityVersion: 1,
    providerIdentity: { provider: 'entra_platform', tenantReference: 'synthetic', subjectReference: 'synthetic' },
    targetScope: { mode: 'all', securityVersion: 1 },
    assurance: { level: 'mfa', authenticationContext: 'synthetic-mfa', authenticatedAt: AT },
    session: { id: CORRELATION, issuedAt: AT, expiresAt: '2026-10-17T10:00:00.000Z',
      securityVersion: 1, securityEpoch: 1, stepUpExpiresAt: null } };
}
function auditRow(patch = {}) {
  return { id: '5', tenantId: TENANT, actorUserId: USER, action: 'request.created',
    targetType: 'request', targetId: REQUEST, previousState: null, newState: { status: 'Submitted' },
    occurredAt: AT, correlationId: CORRELATION, outcome: 'success', metadata: {}, retentionClass: 'business', ...patch };
}
function fixture({ rows = [auditRow()], integrity = true, history, ...overrides } = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const harness = createAuditHarness({ authorizationPolicy });
  const tenantAuditQueryService = createTenantAuditQueryService({ authorizationPolicy,
    queryRepository: { async listByTenantId({ tenantId, categoryActions }) { assert.equal(tenantId, TENANT);
      return rows.filter(row => categoryActions.includes(row.action)); } },
    integrityRepository: { async verifyTenantChain(tenantId) { assert.equal(tenantId, TENANT); return integrity; } },
    auditService: harness.service, clock: () => NOW });
  const defaults = { tenantAuditQueryService, authorizationPolicy, sourceEpoch: 'database-reset-epoch-1',
    readSourceEpoch: async () => 'database-reset-epoch-1', environment: 'demo', clock: () => NOW,
    platformAuthorizationPolicy: { async authorize() { return true; } },
    platformAuditService: { async list() { return []; } },
    requestService: { async getRequestHistory({ requestId, principal: actual }) {
      assert.equal(requestId, REQUEST); assert.equal(actual, principal);
      return { asOfVersion: 2, history: history ?? [{ version: 2, capturedAt: AT, operation: 'transitioned',
        actorAttribution: { displayName: 'PRIVATE NAME', roleAtAction: 'conference_manager' },
        request: { id: REQUEST, version: 2, status: 'Rejected' } }],
      page: { complete: true, nextCursor: null } };
    } } };
  return createWorkflowExtractor({ ...defaults, ...overrides });
}

test('operator extractor reuses real Tenant authorization/integrity and emits only normalized protected facts', async () => {
  const result = await fixture({ rows: [auditRow({ id: '6', action: 'request.transition',
    previousState: { status: 'In Review' }, newState: { status: 'Rejected' } }), auditRow()] }).collectTenant(values);
  assert.deepEqual(result.productEvents.map(x => x.kind), ['request_submitted', 'manager_decision']);
  assert.equal(result.productComplete, false); assert.equal(result.environment, 'demo');
  assert.ok(result.productEvents.every(x => /^[a-f0-9]{64}$/.test(x.sourceId) && x.tenantId === TENANT));
  assert.equal(JSON.stringify(result).includes('PRIVATE NAME'), false);
  assert.equal(JSON.stringify(result).includes(USER), false);
  const repeated = await fixture().collectTenant(values);
  const nextEpoch = await fixture({ sourceEpoch: 'database-reset-epoch-2',
    readSourceEpoch: async () => 'database-reset-epoch-2' }).collectTenant(values);
  assert.notEqual(repeated.productEvents[0].sourceId, nextEpoch.productEvents[0].sourceId);
});

test('source denials, broken chain, foreign Tenant, selector injection and changed epoch fail without partial facts', async () => {
  for (const roles of [['employee'], ['tenant_admin'], ['conference_manager']]) {
    await assert.rejects(fixture().collectTenant({ ...values,
      principal: { userId: USER, tenantId: TENANT, ...tenantAuthorizationSnapshot(roles) } }), /WORKFLOW_EXTRACTION_FAILED/);
  }
  for (const extractor of [fixture({ integrity: false }), fixture({ rows: [auditRow({ tenantId: REQUEST })] }),
    fixture({ readSourceEpoch: async () => 'other' }), fixture({ rows: [auditRow({ occurredAt: '2026-10-16T00:00:00.000Z' })] })]) {
    await assert.rejects(extractor.collectTenant(values), /^Error: WORKFLOW_EXTRACTION_FAILED$/);
  }
  await assert.rejects(fixture().collectTenant({ ...values, tenantId: REQUEST }), /WORKFLOW_EXTRACTION_FAILED/);
  await assert.rejects(fixture().collectTenant({ ...values, tenantContext: { ...context, tenantId: REQUEST } }),
    /WORKFLOW_EXTRACTION_FAILED/);
  let reads = 0;
  await assert.rejects(fixture({ readSourceEpoch: async () => ++reads === 1 ? 'database-reset-epoch-1' : 'other' })
    .collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
});

test('resubmission/failure mapping excludes denial/cancellation; decisions require unique authoritative manager history', async () => {
  const result = await fixture({ rows: [auditRow({ id: '8', action: 'request.transition_failed', outcome: 'failure' }),
    auditRow({ id: '7', action: 'request.transition_failed', outcome: 'denied' }),
    auditRow({ id: '6', action: 'request.transition', previousState: { status: 'Change Requested' } }),
    auditRow({ action: 'request.transition', previousState: { status: 'Submitted' }, newState: { status: 'Cancelled' } })] })
    .collectTenant(values);
  assert.deepEqual(result.productEvents.map(x => x.kind), ['transition_failure', 'request_submitted']);
  const rows = [auditRow({ action: 'request.transition', previousState: { status: 'In Review' }, newState: { status: 'Rejected' } })];
  for (const history of [[], [{ version: 2, operation: 'transitioned', capturedAt: AT,
    actorAttribution: { roleAtAction: 'employee' }, request: { id: REQUEST, version: 2, status: 'Rejected' } }],
    [{ version: 2, operation: 'transitioned', capturedAt: AT, actorAttribution: { roleAtAction: 'conference_manager' },
      request: { id: TENANT, version: 2, status: 'Rejected' } }]]) {
    await assert.rejects(fixture({ rows, history }).collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
  }
});

test('platform extraction preserves separate authorization and excludes preview, denials and reactivation', async () => {
  const base = { sequence: 10, targetTenantId: TENANT, targetId: TENANT, correlationId: CORRELATION,
    occurredAt: AT, outcome: 'success', targetType: 'tenant_recovery',
    metadata: { operation: 'tenant.recovery.last_admin' }, action: 'platform.tenant.lifecycle.changed',
    previousState: { status: 'pending' }, newState: { status: 'onboarding' } };
  const rows = [base, { ...base, sequence: 9, previousState: { status: 'onboarding' }, newState: { status: 'ready' } },
    { ...base, sequence: 8, action: 'platform.recovery.executed' },
    { ...base, sequence: 7, action: 'platform.recovery.executed', outcome: 'failure' },
    { ...base, sequence: 6, action: 'platform.recovery.previewed' },
    { ...base, sequence: 5, action: 'platform.recovery.executed', outcome: 'denied' },
    { ...base, sequence: 4, action: 'platform.recovery.executed', targetType: 'tenant_metering',
      metadata: { operation: 'metering_reconciliation' } },
    { ...base, sequence: 3, previousState: { status: 'suspended' }, newState: { status: 'active' } }];
  const input = { principal: platformPrincipal(), correlationId: CORRELATION };
  const result = await fixture({ platformAuditService: { async list() { return rows; } } }).collectPlatform(input);
  assert.deepEqual(result.productEvents.map(x => x.kind), ['onboarding_completed', 'recovery_completed', 'recovery_failed']);
  assert.equal(result.productComplete, false);
  await assert.rejects(fixture({ platformAuthorizationPolicy: { async authorize() { return false; } } })
    .collectPlatform(input), /WORKFLOW_EXTRACTION_FAILED/);
  await assert.rejects(fixture().collectPlatform({ ...input, principal }), /WORKFLOW_EXTRACTION_FAILED/);
});

test('deadlines and monotonic clocks fail closed; concurrent reads never multiply admitted source work', async () => {
  let epochReads = 0;
  const extractor = fixture({ deadlineMs: 100, readSourceEpoch: async () => {
    epochReads += 1; await new Promise(resolve => setTimeout(resolve, 150)); return 'database-reset-epoch-1';
  } });
  const pending = extractor.collectTenant(values);
  await assert.rejects(extractor.collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
  await assert.rejects(pending, /WORKFLOW_EXTRACTION_FAILED/); assert.equal(epochReads, 1);
  await assert.rejects(extractor.collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
  assert.equal(epochReads, 1, 'A timed-out dependency must settle before another collection is admitted');
  let reads = 0;
  await assert.rejects(fixture({ clock: () => reads++ === 0 ? NOW : NOW - 1 }).collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
});

test('audit pagination advances exactly and source overflow or repeated cursors never become partial output', async () => {
  let calls = 0;
  const projected = id => ({ id: String(id), action: 'request.transition_failed', outcome: 'failure',
    target: { type: 'request', id: REQUEST }, occurredAt: AT, correlationId: CORRELATION });
  const page = async ({ beforeId, from, to, category }) => {
    if (category === 'integration') return { events: [], nextBeforeId: null, window: { from, to } };
    calls += 1;
    assert.equal(beforeId, calls === 1 ? null : '2');
    return { events: calls === 1 ? [projected(3), projected(2)] : [projected(1)],
      nextBeforeId: calls === 1 ? '2' : null, window: { from, to } };
  };
  const result = await fixture({ tenantAuditQueryService: { listEvents: page } }).collectTenant(values);
  assert.equal(calls, 2); assert.equal(result.productEvents.length, 3);
  await assert.rejects(fixture({ tenantAuditQueryService: { async listEvents({ from, to }) {
    return { events: [projected(3)], nextBeforeId: '4', window: { from, to } };
  } } }).collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
  let sequence = 3000;
  await assert.rejects(fixture({ tenantAuditQueryService: { async listEvents({ from, to }) {
    const events = Array.from({ length: 100 }, () => projected(sequence--));
    return { events, nextBeforeId: events.at(-1).id, window: { from, to } };
  } } }).collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
});

test('history anchors and unique manager-decision identities reject ambiguous or repeated source facts', async () => {
  const rows = [auditRow({ action: 'request.transition', previousState: { status: 'In Review' },
    newState: { status: 'Rejected' } })];
  const history = [2, 1].map(version => ({ version, capturedAt: AT, operation: 'transitioned',
    actorAttribution: { roleAtAction: 'conference_manager' }, request: { id: REQUEST, version, status: 'Rejected' } }));
  await assert.rejects(fixture({ rows, history }).collectTenant(values), /WORKFLOW_EXTRACTION_FAILED/);
  await assert.rejects(fixture({ rows: [rows[0], { ...rows[0], id: '4' }] }).collectTenant(values),
    /WORKFLOW_EXTRACTION_FAILED/);
});

test('real claim evidence supplies onboarding starts; synthetic Platform lifecycle entry cannot', async () => {
  const result = await fixture({ rows: [auditRow({ action: 'tenant.identity.claimed',
    targetType: 'tenant_identity', targetId: TENANT, metadata: { onboardingStarted: true },
    newState: { provider: 'entra', status: 'active' } }), auditRow({ id: '4', action: 'tenant.identity.claimed',
    targetType: 'tenant_identity', targetId: TENANT, metadata: { onboardingStarted: false } }),
    auditRow({ id: '3', action: 'tenant.identity.claimed', targetType: 'tenant_identity', targetId: TENANT })] })
    .collectTenant(values);
  assert.deepEqual(result.productEvents.map(event => event.kind), ['onboarding_started']);
});

test('Platform source gets the bounded reporting window and the normalized authorization snapshot', async () => {
  let calls = 0;
  const input = { principal: platformPrincipal(), correlationId: CORRELATION };
  const result = await fixture({ platformAuditService: { async list(query) {
    calls += 1; assert.equal(query.from, '2026-09-18T00:00:00.000Z');
    assert.equal(query.to, '2026-10-16T00:00:00.000Z');
    assert.equal(Object.isFrozen(query.principal), true);
    return [];
  } } }).collectPlatform(input);
  assert.equal(calls, 1); assert.deepEqual(result.productEvents, []);
});

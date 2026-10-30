import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';
import {
  createPostgresPlatformRecoveryRepository,
} from '../src/persistence/postgres/platform-operations-recovery-repository.js';
import { withPostgresTransaction, isPostgresTransactionActive } from '../src/persistence/postgres/transaction.js';

const OPERATOR_ID = 'f1111111-1111-4111-8111-111111111111';
const TENANT_ID = 'f2222222-2222-4222-8222-222222222222';
const SESSION_ID = 'f3333333-3333-4333-8333-333333333333';
const CONTEXT_ID = 'f4444444-4444-4444-8444-444444444444';
const IDEMPOTENCY_KEY = 'f5555555-5555-4555-8555-555555555555';
const OCCURRED_AT = '2026-08-30T12:00:00.000Z';

function authorization() {
  return Object.freeze({
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    principal: Object.freeze({
      operatorId: OPERATOR_ID,
      securityVersion: 2,
      roles: Object.freeze(['security_admin']),
      permissions: Object.freeze([PLATFORM_PERMISSION.RECOVERY_EXECUTE]),
      assurance: Object.freeze({ level: 'step_up', authenticatedAt: OCCURRED_AT }),
      session: Object.freeze({ id: SESSION_ID, securityEpoch: 1 }),
    }),
  });
}

function lifecycleProbe({ expectedStatus, targetStatus, revision, outcome = 'updated' }) {
  const operation = targetStatus === 'suspended'
    ? PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT
    : PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT;
  const stateBinding = Object.freeze({
    lifecycleRevision: revision,
    lifecycleStatus: expectedStatus,
  });
  const state = { lifecycleCalls: [], consumed: 0, receipts: 0, tenantAudits: 0, platformAudits: 0 };
  const client = {
    async query(statement) {
      if (typeof statement === 'string') return { rowCount: 0, rows: [] };
      if (statement.name === 'platform-operation-receipt-advisory-lock') {
        return { rowCount: 1, rows: [{}] };
      }
      if (statement.name === 'platform-operation-receipt-find') {
        return { rowCount: 0, rows: [] };
      }
      if (statement.name === 'platform-operation-authorize-target') {
        return { rowCount: 1, rows: [{}] };
      }
      if (statement.name === 'platform-recovery-context-lock') {
        return {
          rowCount: 1,
          rows: [{
            id: CONTEXT_ID,
            operation,
            tenant_id: TENANT_ID,
            target_id: TENANT_ID,
            state_binding: stateBinding,
            expires_at: '2026-08-30T12:15:00.000Z',
            used_at: null,
          }],
        };
      }
      if (statement.name === 'platform-recovery-context-consume') {
        state.consumed += 1;
        return { rowCount: 1, rows: [] };
      }
      if (statement.name === 'platform-operation-receipt-insert') {
        state.receipts += 1;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`UNEXPECTED_QUERY:${statement.name}`);
    },
    release() {},
  };
  const pool = {
    query: (...args) => client.query(...args),
    connect: async () => client,
  };
  const tenantLifecycleRepository = {
    async changeStatusWithClient(receivedClient, values) {
      assert.equal(receivedClient, client);
      state.lifecycleCalls.push(values);
      if (outcome !== 'updated') return Object.freeze({ outcome });
      return Object.freeze({
        outcome: 'updated',
        tenant: Object.freeze({ id: TENANT_ID, status: targetStatus, updatedAt: OCCURRED_AT }),
        revision: revision + 1,
        customerSessionRevision: targetStatus === 'suspended' ? 2 : 1,
        revokedSessionCount: targetStatus === 'suspended' ? 1 : 0,
      });
    },
  };
  const repository = createPostgresPlatformRecoveryRepository(pool, {
    tenantAuditRepository: {
      async appendWithClient() {
        state.tenantAudits += 1;
        return { tenantId: TENANT_ID };
      },
    },
    platformAuditRepository: {
      async appendWithClient() {
        state.platformAudits += 1;
        return { targetTenantId: TENANT_ID };
      },
    },
    onboardingRepository: { async unbindActiveWithClient() {} },
    tenantLifecycleRepository,
    cursorSecret: 'platform-recovery-persistence-test-secret-32-bytes',
  });
  return {
    execute: () => repository.recoveryContextTransactions.executeTenantLifecycle({
      authorization: authorization(),
      operation,
      tenantId: TENANT_ID,
      targetId: TENANT_ID,
      contextId: CONTEXT_ID,
      expectedStateBinding: stateBinding,
      targetStatus,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestDigest: 'a'.repeat(64),
      occurredAt: OCCURRED_AT,
      evidence: Object.freeze({ tenantAuditEvent: {}, platformAuditEvent: {} }),
    }),
    state,
  };
}

for (const scenario of [
  { expectedStatus: 'active', targetStatus: 'suspended', revision: 7 },
  { expectedStatus: 'suspended', targetStatus: 'active', revision: 8 },
]) {
  test(`Recovery ${scenario.targetStatus} delegates its exact state binding to Tenant lifecycle persistence`, async () => {
    const probe = lifecycleProbe(scenario);
    const result = await probe.execute();
    assert.equal(result.outcome, 'updated');
    assert.deepEqual(probe.state.lifecycleCalls, [{
      tenantId: TENANT_ID,
      expectedStatus: scenario.expectedStatus,
      expectedRevision: scenario.revision,
      targetStatus: scenario.targetStatus,
      changedAt: new Date(OCCURRED_AT),
    }]);
    assert.equal(probe.state.consumed, 1);
    assert.equal(probe.state.receipts, 1);
    assert.equal(probe.state.tenantAudits, 1);
    assert.equal(probe.state.platformAudits, 1);
  });
}

test('a stale canonical lifecycle result leaves recovery context and evidence unconsumed', async () => {
  const probe = lifecycleProbe({
    expectedStatus: 'active',
    targetStatus: 'suspended',
    revision: 7,
    outcome: 'stale',
  });
  assert.deepEqual(await probe.execute(), { outcome: 'stale' });
  assert.equal(probe.state.lifecycleCalls.length, 1);
  assert.equal(probe.state.consumed, 0);
  assert.equal(probe.state.receipts, 0);
  assert.equal(probe.state.tenantAudits, 0);
  assert.equal(probe.state.platformAudits, 0);
});

function singleConnectionRecoveryProbe({ failAudit = false } = {}) {
  const state = { borrowed: false, connections: 0, audits: 0, queries: [], released: 0 };
  const client = {
    async query(statement) {
      state.queries.push(typeof statement === 'string' ? statement : statement.name);
      if (typeof statement === 'string') return { rows: [], rowCount: 0 };
      assert.equal(isPostgresTransactionActive(pool, client), true);
      if (statement.name === 'platform-recovery-target-clock') {
        return { rows: [{ snapshot_at: new Date(OCCURRED_AT) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { state.borrowed = false; state.released++; },
  };
  const pool = {
    async query() { throw new Error('RECOVERY_READ_ESCAPED_CURRENT_TRANSACTION'); },
    async connect() {
      assert.equal(state.borrowed, false, 'A proof read must not acquire a second max1 connection');
      state.borrowed = true; state.connections++; return client;
    },
  };
  const repository = createPostgresPlatformRecoveryRepository(pool, {
    tenantAuditRepository: { async appendWithClient() { assert.fail('Target discovery must not append Tenant mutation evidence'); } },
    platformAuditRepository: { async appendWithClient(received, _event, options) {
      assert.equal(received, client); assert.equal(isPostgresTransactionActive(pool, client), true);
      assert.equal(options.expectedTargetTenantId, TENANT_ID); state.audits++;
      if (failAudit) throw new Error('SYNTHETIC_ACCESS_AUDIT_FAILURE');
      return { targetTenantId: TENANT_ID };
    } },
    onboardingRepository: { async unbindActiveWithClient() { assert.fail('Read cannot unbind identity'); } },
    tenantLifecycleRepository: { async changeStatusWithClient() { assert.fail('Read cannot change lifecycle'); } },
    cursorSecret: 'platform-recovery-persistence-test-secret-32-bytes',
  });
  const previous = authorization();
  const authority = { ...previous, principal: { ...previous.principal, targetScope: { mode: 'all' } } };
  const list = operation => repository.recoveryTargetReader.list({ tenantId: TENANT_ID, operation,
    limit: 50, cursor: null, authorization: authority, evidence: { platformAuditEvent: {} } });
  return { pool, repository, state, authority, list };
}

test('Recovery inspections, contexts and all target lists reuse the current proof transaction with a max1 pool', async () => {
  const probe = singleConnectionRecoveryProbe();
  await withPostgresTransaction(probe.pool, async () => {
    for (const method of ['lastTenantAdmin', 'microsoftReconsent', 'roomMappingRepair', 'identityUnbind',
      'tenantSessionRevocation', 'userSessionRevocation', 'tenantLifecycle']) {
      await probe.repository.recoveryInspector[method]({ tenantId: TENANT_ID, targetUserId: SESSION_ID, mappingId: CONTEXT_ID });
    }
    assert.equal(await probe.repository.recoveryContextReader.findForExecution({
      authorization: probe.authority, contextId: CONTEXT_ID,
    }), null);
    for (const operation of ['last-tenant-admin', 'room-mapping-repair', 'user-session-revocation']) {
      const page = await probe.list(operation); assert.deepEqual(page.items, []); assert.equal(page.nextCursor, null);
    }
  });
  assert.equal(probe.state.connections, 1); assert.equal(probe.state.released, 1); assert.equal(probe.state.audits, 3);
  assert.equal(probe.state.queries.filter(value => value === 'COMMIT').length, 1);
  assert.equal(probe.state.queries.includes('ROLLBACK'), false);
});

test('ordinary Recovery target discovery owns one transaction for its bounded read and access audit', async () => {
  const probe = singleConnectionRecoveryProbe();
  assert.deepEqual((await probe.list('room-mapping-repair')).items, []);
  assert.equal(probe.state.connections, 1); assert.equal(probe.state.audits, 1);
  assert.equal(probe.state.queries.at(-1), 'COMMIT'); assert.equal(probe.state.released, 1);
});

test('a failed Recovery target access audit rolls back the current proof without returning a target page', async () => {
  const probe = singleConnectionRecoveryProbe({ failAudit: true });
  await assert.rejects(withPostgresTransaction(probe.pool, () => probe.list('room-mapping-repair')),
    /SYNTHETIC_ACCESS_AUDIT_FAILURE/);
  assert.equal(probe.state.connections, 1); assert.equal(probe.state.audits, 1);
  assert.equal(probe.state.queries.includes('COMMIT'), false); assert.equal(probe.state.queries.at(-1), 'ROLLBACK');
  assert.equal(probe.state.released, 1);
});

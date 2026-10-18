import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { reconcileTargetLoad } from '../scripts/support/target-load-reconciliation.mjs';
import { targetLoadManifest } from './support/target-load-manifest.js';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';

async function fixture() {
  const manifest = await targetLoadManifest(); const requestId = randomUUID(); const tenantId = manifest.tenants[0];
  const actorUserId = manifest.managers[0].userId; const idempotency = 'a'.repeat(64); let closed = 0;
  const queries = []; let corrupt = false;
  const rows = [{ requestId, tenantId, actorUserId }];
  return { queries, closeCount: () => closed, corrupt() { corrupt = true; }, options: {
    env: targetLoadSetupEnvironment(), manifest, campaigns: [{ results: rows }], clock: () => NOW, async verifyDatabase() {},
    persistenceFactory: () => ({ async close() { closed += 1; }, auditRepository: { async verifyTenantChain() { return !corrupt; } },
      pool: { async query(sql) {
        queries.push(sql);
        if (sql.includes('platform_projection_outbox')) return { rows: [{ count: 0 }] };
        if (sql.includes('FROM public.requests LIMIT')) return { rowCount: 1,
          rows: [{ id: requestId, tenant_id: tenantId, status: 'Confirmed', request_version: 3 }] };
        if (sql.includes('FROM public.booking_provider_references')) return { rowCount: 1, rows: [{ tenant_id: tenantId,
          request_id: requestId, state: 'active', idempotency_key: idempotency,
          provider_reference: `fixture-${createHash('sha256').update(idempotency).digest('hex')}`,
          provider_resource_reference: 'room0@synthetic.invalid' }] };
        if (sql.includes('count(*)::int AS count FROM public.request_revisions')) return { rows: [{ count: 3 }] };
        if (sql.includes('JOIN public.audit_events')) return { rowCount: 2, rows: [2, 3].map(version => ({
          tenant_id: tenantId, request_id: requestId, request_version: version, actor_user_id: actorUserId,
          audit_actor: actorUserId, actor_role_at_action: 'conference_manager', outcome: 'success',
          previous_state: { status: version === 2 ? 'Submitted' : 'In Review' },
          new_state: { status: version === 2 ? 'In Review' : 'Confirmed' },
          record: { status: version === 2 ? 'In Review' : 'Confirmed', version, pricing: { totalMinor: 1000 } },
        })) };
        if (sql.includes('AS users,')) return { rows: [{ users: 110, sessions: 110 }] };
        assert.fail('Unexpected reconciliation query');
      } } }),
  } };
}

test('reconciliation verifies request/reference/version/actor/price/HMAC state and returns only aggregate evidence', async () => {
  const f = await fixture(); const result = await reconcileTargetLoad(f.options);
  assert.deepEqual(result, { confirmedBookings: 1, activeFixtureReferences: 1, requestRevisions: 3,
    transitionActorCorrelations: 2, verifiedTenantAuditChains: 10, pendingProjectionWork: 0,
    retainedEmployees: 100, retainedManagers: 10 });
  assert.equal(f.queries.every(sql => sql.startsWith('SELECT')), true); assert.equal(f.closeCount(), 1);
  assert.equal(JSON.stringify(result).includes('cm_session='), false);
});

test('corrupted Tenant audit integrity cannot become accepted evidence and always releases installer custody', async () => {
  const f = await fixture(); f.corrupt();
  await assert.rejects(reconcileTargetLoad(f.options), /^Error: LOAD_TARGET_RECONCILIATION_FAILED$/);
  assert.equal(f.closeCount(), 1);
});

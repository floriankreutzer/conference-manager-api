import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringOperationalHealthService } from '../src/application/catering-operational-health-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const context = () => ({ principal: { tenantId: id(1), userId: id(30), roles: ['tenant_admin'],
  permissions: ['tenant:integrations:manage'], session: { id: id(40), securityVersion: 1 } },
tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(90), integrationId: id(3) });
const row = () => ({ tenantId: id(1), integrationId: id(3), providerId: 'manual_catering', configurationRevision: 1,
  configuration: { initialOrderMode: 'manager_review', capabilities: { 'catering.order': 'manual' } },
  connectionAvailable: true, tenantBusinessActive: true, observedAt: '2026-10-19T12:00:00.000Z', jobs: [] });
function fixture(value = row(), processingEnabled = true) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy });
  const calls = []; const repository = { async load(input) { calls.push(input); return value; } };
  return { calls, audit, service: createCateringOperationalHealthService({ repository, authorizationPolicy, processingEnabled,
    registry: createCateringConfigurationRegistry(), auditService: audit.service }) };
}
test('Tenant Admin receives a scoped minimized read-only operational snapshot without a provider health claim', async () => {
  const f = fixture(); const value = await f.service.current(context());
  assert.deepEqual(f.calls, [{ tenantId: id(1), integrationId: id(3) }]);
  assert.equal(value.state, 'idle');
  assert.equal((await fixture(row(), false).service.current(context())).state, 'disabled');
  assert.equal((await fixture(row(), false).service.current(context())).dispatchEnabled, false);
  assert.equal(value.providerId, 'manual_catering');
  assert.deepEqual(value.coverage, { limit: 1000, complete: true }); assert.equal(Object.isFrozen(value.counts), true);
  assert.doesNotMatch(JSON.stringify(value), /tenantId|credential|sessionId|actor|providerReference|orderId|jobId|healthy/);
  const onboarding = context(); onboarding.tenantContext.status = 'onboarding';
  assert.equal((await fixture({ ...row(), tenantBusinessActive: false }).service.current(onboarding)).state, 'disabled');
});
test('Manager, Employee, Platform, absent permission, foreign Tenant and disabled lifecycle cannot read health evidence', async () => {
  const f = fixture();
  for (const role of ['conference_manager','employee','platform_admin']) {
    const value = context(); value.principal.roles = [role];
    assert.equal(asApiError(await f.service.current(value).catch((error) => error)).statusCode, 403);
  }
  const missing = context(); missing.principal.permissions = []; await assert.rejects(f.service.current(missing));
  const foreign = context(); foreign.tenantContext.tenantId = id(99); await assert.rejects(f.service.current(foreign));
  for (const status of ['suspended','archived','unknown']) {
    const disabled = context(); disabled.tenantContext.status = status; await assert.rejects(f.service.current(disabled));
  }
  assert.equal(f.calls.length, 0); assert.ok(f.audit.events.every((event) => event.action === 'authorization.denied'));
});
test('hidden connections and corrupt or private repository evidence never become a health success', async () => {
  assert.equal(asApiError(await fixture(null).service.current(context()).catch((error) => error)).statusCode, 404);
  for (const extra of [{ tenantId: id(99) }, { integrationId: id(99) }, { providerId: 'unqualified' },
    { configurationRevision: 0 }, { configurationRevision: Number.MAX_SAFE_INTEGER }, { observedAt: 'invalid' },
    { credentialReference: 'private' }, { connectionAvailable: 'true' }, { jobs: [{}] },
    { configuration: { initialOrderMode: 'invented', capabilities: {} } }]) {
    await assert.rejects(fixture({ ...row(), ...extra }).service.current(context()), /INVALID/);
  }
  let reads = 0; const value = row();
  Object.defineProperty(value, 'jobs', { enumerable: true, get() { reads++; return []; } });
  await assert.rejects(fixture(value).service.current(context()), /INVALID/); assert.equal(reads, 0);
  for (const extra of [{ integrationId: '../foreign' }, { correlationId: 'invalid' }]) {
    const f = fixture(); assert.equal(asApiError(await f.service.current({ ...context(), ...extra })
      .catch((error) => error)).statusCode, 400); assert.equal(f.calls.length, 0);
  }
});

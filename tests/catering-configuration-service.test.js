import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringConfigurationService } from '../src/application/catering-configuration-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createProviderRegistry } from '../src/integrations/provider-registry.js';
import { normalizeCateringConfiguration } from '../src/integrations/catering-configuration.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const TENANT = id(1);
const INTEGRATION = id(2);
const PROVIDER = { id: 'reference_one', runtime: 'production', capabilities: { 'catering.order': 'api' } };
const OTHER = { id: 'reference_two', runtime: 'production', capabilities: { 'catering.order': 'manual' } };
const configuration = (initialOrderMode = 'manager_review', mode = 'api') => ({
  initialOrderMode, capabilities: { 'catering.order': mode },
});
const principal = (roles = ['tenant_admin'], permissions = ['tenant:integrations:manage'], tenantId = TENANT) => ({
  tenantId, userId: id(3), roles, permissions,
  session: { id: id(8), securityVersion: 1 },
});
const context = (overrides = {}) => ({
  principal: principal(), tenantContext: { tenantId: TENANT, status: 'active' },
  integrationId: INTEGRATION, correlationId: id(4), ...overrides,
});
const command = (overrides = {}) => ({
  ...context(), schemaVersion: 1, expectedRevision: 1, configuration: configuration('after_conference_approval'), ...overrides,
});

function fixture() {
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [PROVIDER, OTHER] });
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const normalized = normalizeCateringConfiguration(configuration(), PROVIDER);
  const rows = new Map([[INTEGRATION, {
    tenantId: TENANT, integrationId: INTEGRATION, providerId: PROVIDER.id, revision: 1,
    configuration: { initialOrderMode: normalized.initialOrderMode, capabilities: normalized.capabilities },
    credentialReference: 'server-only-reference',
  }]]);
  const calls = [];
  const store = {
    async loadCurrent(input) {
      calls.push({ operation: 'load', ...input });
      const row = rows.get(input.integrationId);
      return row?.tenantId === input.tenantId ? row : null;
    },
    async update(input) {
      calls.push({ operation: 'update', ...input });
      const row = rows.get(input.integrationId);
      if (!row || row.tenantId !== input.tenantId || row.providerId !== input.providerId) return { status: 'not_found' };
      if (row.revision !== input.expectedRevision) return { status: 'conflict', currentRevision: row.revision };
      const revision = row.revision + 1;
      const event = input.auditEventFor({ revision });
      assert.equal(event.tenantId, TENANT);
      assert.equal(event.actorUserId, id(3));
      assert.equal(event.action, 'tenant.configuration.changed');
      assert.deepEqual(event.metadata, { operation: 'catering_configuration_update' });
      const current = { ...row, revision, configuration: input.configuration };
      rows.set(input.integrationId, current);
      return { status: 'updated', current };
    },
  };
  const makeService = (overrides = {}) => createCateringConfigurationService({
    repository: store, registry, authorizationPolicy, auditService: audit.service,
    clock: () => Date.parse('2026-10-19T10:00:00.000Z'), ...overrides,
  });
  return { service: makeService(), makeService, store, rows, calls, audit };
}

test('Tenant Admin reads and changes only the selected provider configuration with a versioned audit command', async () => {
  const f = fixture();
  const current = await f.service.current(context());
  assert.equal(current.revision, 1);
  assert.equal(current.configuration.initialOrderMode, 'manager_review');
  assert.equal(Object.hasOwn(current, 'credentialReference'), false);
  const changed = await f.service.update(command());
  assert.equal(changed.revision, 2);
  assert.equal(changed.configuration.initialOrderMode, 'after_conference_approval');
  assert.equal(changed.configuration.capabilities['catering.order'], 'api');
  assert.ok(Object.isFrozen(changed.configuration.capabilities));
  const write = f.calls.find((call) => call.operation === 'update');
  assert.equal(write.tenantId, TENANT);
  assert.equal(write.actorUserId, id(3));
  assert.equal(write.sessionId, id(8));
  assert.equal(write.expectedSecurityVersion, 1);
  assert.equal(write.providerId, PROVIDER.id);
  assert.equal(write.changedAt.toISOString(), '2026-10-19T10:00:00.000Z');
  assert.equal(write.correlationId, id(4));
});

test('provider modes remain independent and cannot upgrade a manual provider to API execution', async () => {
  const f = fixture();
  f.rows.set(id(5), {
    tenantId: TENANT, integrationId: id(5), providerId: OTHER.id, revision: 1, configuration: configuration('manager_review', 'manual'),
  });
  await f.service.update(command());
  assert.equal((await f.service.current(context({ integrationId: id(5) }))).configuration.initialOrderMode, 'manager_review');
  await assert.rejects(f.service.update(command({ integrationId: id(5), configuration: configuration() })),
    /CATERING_CONFIGURATION_INVALID/);
  assert.equal(f.rows.get(id(5)).revision, 1);
});

test('Employee, Manager, spoofed permissions and Platform roles cannot access provider configuration', async () => {
  for (const actor of [
    principal(['employee'], ['request:read']), principal(['conference_manager'], ['request:manage']),
    principal(['conference_manager'], ['tenant:integrations:manage']), principal(['platform_admin']),
    principal(['tenant_admin'], []),
  ]) {
    const f = fixture();
    await assert.rejects(f.service.current(context({ principal: actor })));
    await assert.rejects(f.service.update(command({ principal: actor })));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  assert.equal((await f.service.current(context({
    principal: principal(['conference_manager', 'tenant_admin'], ['request:manage', 'tenant:integrations:manage']),
  }))).providerId, PROVIDER.id);
});

test('Tenant mismatch, foreign Integration IDs and unavailable lifecycle fail before any write', async () => {
  const f = fixture();
  await assert.rejects(f.service.current(context({ tenantContext: { tenantId: id(9), status: 'active' } })),
    /TENANT_SCOPE_INVALID/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.service.current(context({
    principal: principal(undefined, undefined, id(9)), tenantContext: { tenantId: id(9), status: 'active' },
  })), /RESOURCE_NOT_AVAILABLE/);
  assert.equal(f.calls.at(-1).tenantId, id(9));
  for (const status of ['suspended', 'archived', 'unknown', undefined]) {
    const count = f.calls.length;
    await assert.rejects(f.service.update(command({ tenantContext: { tenantId: TENANT, status } })));
    assert.equal(f.calls.length, count);
  }
  assert.equal(f.rows.get(INTEGRATION).revision, 1);
});

test('stale requests and a concurrent compare-and-swap loss never report configuration success', async () => {
  const f = fixture();
  await f.service.update(command());
  await assert.rejects(f.service.update(command()), /TENANT_SETTINGS_REVISION_CONFLICT/);
  assert.equal(f.calls.filter((call) => call.operation === 'update').length, 1);
  const raced = f.makeService({ repository: {
    loadCurrent: f.store.loadCurrent,
    async update() { return { status: 'conflict', currentRevision: 3 }; },
  } });
  await assert.rejects(raced.update(command({ expectedRevision: 2 })), /TENANT_SETTINGS_REVISION_CONFLICT/);
  assert.equal(f.rows.get(INTEGRATION).revision, 2);
});

test('configuration rejects credentials, endpoints, provider overrides and malformed revisions', async () => {
  const f = fixture();
  for (const extra of [{ tenantId: id(9) }, { providerId: OTHER.id }, { credentials: 'untrusted' },
    { endpoint: 'https://other.test' }, { approved: true }, { health: 'healthy' }]) {
    await assert.rejects(f.service.update(command({ configuration: { ...configuration(), ...extra } })),
      /CATERING_CONFIGURATION_INVALID/);
  }
  for (const expectedRevision of [0, -1, 1.1, Number.MAX_SAFE_INTEGER, '1']) {
    await assert.rejects(f.service.update(command({ expectedRevision })), /TENANT_SETTINGS_REVISION_INVALID/);
  }
  await assert.rejects(f.service.update(command({ schemaVersion: 2 })), /TENANT_SETTINGS_SCHEMA_VERSION_UNSUPPORTED/);
  assert.equal(f.calls.some((call) => call.operation === 'update'), false);
});

test('cross-scope, unknown-provider and altered repository results fail closed without projecting secret references', async () => {
  for (const changed of [{ tenantId: id(9) }, { integrationId: id(9) }, { providerId: 'unknown' }]) {
    const f = fixture();
    const wrong = { ...f.rows.get(INTEGRATION), ...changed };
    const service = f.makeService({ repository: { ...f.store, async loadCurrent() { return wrong; } } });
    await assert.rejects(service.current(context()));
  }
  const f = fixture();
  for (const changed of [{ providerId: OTHER.id }, { revision: 3 }, { configuration: configuration() }]) {
    const service = f.makeService({ repository: { ...f.store, async update() {
      return { status: 'updated', current: { ...f.rows.get(INTEGRATION), revision: 2, ...changed } };
    } } });
    await assert.rejects(service.update(command()));
  }
});

test('audit construction failure propagates and cannot become an acknowledged mutation', async () => {
  const f = fixture();
  const service = f.makeService({ auditService: {
    recordAuthorizationDenied: f.audit.service.recordAuthorizationDenied,
    createEvent() { throw new Error('AUDIT_UNAVAILABLE'); },
  } });
  await assert.rejects(service.update(command()), /AUDIT_UNAVAILABLE/);
  assert.equal(f.rows.get(INTEGRATION).revision, 1);
});

test('mutation requires a session fence and propagates transaction-time revocation denial', async () => {
  for (const session of [undefined, {}, { id: 'unknown', securityVersion: 1 }, { id: id(8), securityVersion: 0 }]) {
    const f = fixture();
    await assert.rejects(f.service.update(command({ principal: { ...principal(), session } })), /PRINCIPAL_NOT_AUTHORIZED/);
    assert.equal(f.calls.some((call) => call.operation === 'update'), false);
  }
  const f = fixture();
  const revoked = f.makeService({ repository: {
    loadCurrent: f.store.loadCurrent, async update() { return { status: 'not_authorized' }; },
  } });
  await assert.rejects(revoked.update(command()), /PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal(f.rows.get(INTEGRATION).revision, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TenantInputError,
  TenantRepositoryContractError,
  TenantUnavailableError,
} from '../src/tenancy/errors.js';
import { createTenantContextGuard } from '../src/tenancy/tenant-context.js';
import { createTenantScopedRepository } from '../src/tenancy/tenant-scoped-repository.js';
import {
  TENANT_OWNED_RESOURCE_TYPES,
  TENANT_STATUS,
  isTenantBusinessActive,
  isTenantSessionAvailable,
  normalizeTenant,
} from '../src/tenancy/tenant.js';

const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';

function tenant(id, status = TENANT_STATUS.ACTIVE, displayName = 'Tenant') {
  return {
    id,
    displayName,
    status,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function principal(tenantId) {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId,
    roles: ['employee'],
  };
}

function memoryAdapter() {
  const records = new Map();
  const key = (tenantId, id) => `${tenantId}:${id}`;

  return {
    async findByTenantIdAndId(tenantId, id) {
      return records.get(key(tenantId, id)) || null;
    },
    async listByTenantId(tenantId) {
      return [...records.values()].filter((record) => record.tenantId === tenantId);
    },
    async insertForTenant(tenantId, value) {
      const record = { ...value, tenantId };
      records.set(key(tenantId, value.id), record);
      return record;
    },
    async updateByTenantIdAndId(tenantId, id, value) {
      const current = records.get(key(tenantId, id));
      if (!current) return null;
      const updated = { ...current, ...value, id, tenantId };
      records.set(key(tenantId, id), updated);
      return updated;
    },
    async deleteByTenantIdAndId(tenantId, id) {
      return records.delete(key(tenantId, id));
    },
  };
}

test('canonical tenant model separates internal ownership from external provider identity', () => {
  const normalized = normalizeTenant(tenant(TENANT_A));
  assert.equal(normalized.id, TENANT_A);
  assert.equal(normalized.status, TENANT_STATUS.ACTIVE);
  assert.throws(
    () => normalizeTenant({ ...tenant(TENANT_A), externalTenantId: 'entra-tenant-id' }),
    TypeError,
  );

  assert.deepEqual(TENANT_OWNED_RESOURCE_TYPES, [
    'user',
    'site',
    'room',
    'service',
    'catering_package',
    'catering_item',
    'request',
    'notification',
    'integration',
    'entitlement',
    'booking_provider_reference',
    'tenant_onboarding_invitation',
    'tenant_identity_binding',
    'audit_event',
    'tenant_configuration',
  ]);
});

test('tenant lifecycle access fails closed for suspended and archived tenants', () => {
  assert.equal(isTenantSessionAvailable(tenant(TENANT_A, TENANT_STATUS.PENDING)), true);
  assert.equal(isTenantSessionAvailable(tenant(TENANT_A, TENANT_STATUS.ONBOARDING)), true);
  assert.equal(isTenantSessionAvailable(tenant(TENANT_A, TENANT_STATUS.READY)), true);
  assert.equal(isTenantSessionAvailable(tenant(TENANT_A, TENANT_STATUS.ACTIVE)), true);
  assert.equal(isTenantSessionAvailable(tenant(TENANT_A, TENANT_STATUS.SUSPENDED)), false);
  assert.equal(isTenantSessionAvailable(tenant(TENANT_A, TENANT_STATUS.ARCHIVED)), false);
  assert.equal(isTenantBusinessActive(tenant(TENANT_A, TENANT_STATUS.ACTIVE)), true);
  assert.equal(isTenantBusinessActive(tenant(TENANT_A, TENANT_STATUS.READY)), false);
});

test('tenant context is resolved only from the authenticated principal tenant', async () => {
  const tenants = new Map([
    [TENANT_A, tenant(TENANT_A, TENANT_STATUS.ACTIVE, 'Alpha')],
    [TENANT_B, tenant(TENANT_B, TENANT_STATUS.ACTIVE, 'Beta')],
  ]);
  const guard = createTenantContextGuard({
    loadTenant: async (tenantId) => tenants.get(tenantId) || null,
  });

  const context = await guard.requireKnown(principal(TENANT_A));
  assert.equal(context.tenantId, TENANT_A);
  assert.equal(context.tenant.displayName, 'Alpha');

  await assert.rejects(
    guard.requireKnown(principal('44444444-4444-4444-8444-444444444444')),
    TenantUnavailableError,
  );
});

test('disabled or mismatched tenant records fail closed', async () => {
  const suspended = createTenantContextGuard({
    loadTenant: async () => tenant(TENANT_A, TENANT_STATUS.SUSPENDED),
  });
  await assert.rejects(suspended.requireKnown(principal(TENANT_A)), TenantUnavailableError);

  const archived = createTenantContextGuard({
    loadTenant: async () => tenant(TENANT_A, TENANT_STATUS.ARCHIVED),
  });
  await assert.rejects(archived.requireKnown(principal(TENANT_A)), TenantUnavailableError);

  const mismatched = createTenantContextGuard({
    loadTenant: async () => tenant(TENANT_B),
  });
  await assert.rejects(
    mismatched.requireKnown(principal(TENANT_A)),
    TenantRepositoryContractError,
  );
});

test('tenant-scoped repository isolates read, update and delete by construction', async () => {
  const repository = createTenantScopedRepository(memoryAdapter());
  const contextA = { tenantId: TENANT_A };
  const contextB = { tenantId: TENANT_B };

  await repository.create(contextA, { id: 'room-a', name: 'Alpha Room' });
  await repository.create(contextB, { id: 'room-b', name: 'Beta Room' });

  assert.equal((await repository.get(contextA, 'room-a')).name, 'Alpha Room');
  assert.equal(await repository.get(contextB, 'room-a'), null);
  assert.deepEqual((await repository.list(contextA)).map((room) => room.id), ['room-a']);
  assert.deepEqual((await repository.list(contextB)).map((room) => room.id), ['room-b']);

  assert.equal(await repository.update(contextB, 'room-a', { name: 'Stolen' }), null);
  assert.equal((await repository.get(contextA, 'room-a')).name, 'Alpha Room');
  assert.equal(await repository.delete(contextB, 'room-a'), false);
  assert.notEqual(await repository.get(contextA, 'room-a'), null);
});

test('tenant-scoped repository rejects tenant-field manipulation and guessed invalid IDs', async () => {
  const repository = createTenantScopedRepository(memoryAdapter());
  const contextA = { tenantId: TENANT_A };

  await assert.rejects(
    repository.create(contextA, { id: 'room-a', tenantId: TENANT_B }),
    TenantInputError,
  );
  await assert.rejects(
    repository.get(contextA, '../../room-a'),
    TenantInputError,
  );
});

test('concurrent tenants may use the same resource ID without sharing records', async () => {
  const repository = createTenantScopedRepository(memoryAdapter());
  const contextA = { tenantId: TENANT_A };
  const contextB = { tenantId: TENANT_B };

  await Promise.all([
    repository.create(contextA, { id: 'shared-room', name: 'Alpha' }),
    repository.create(contextB, { id: 'shared-room', name: 'Beta' }),
  ]);

  assert.equal((await repository.get(contextA, 'shared-room')).name, 'Alpha');
  assert.equal((await repository.get(contextB, 'shared-room')).name, 'Beta');
});

test('repository adapter tenant leakage is detected as a server contract violation', async () => {
  const adapter = memoryAdapter();
  adapter.findByTenantIdAndId = async () => ({
    id: 'room-a',
    tenantId: TENANT_B,
  });
  const repository = createTenantScopedRepository(adapter);

  await assert.rejects(
    repository.get({ tenantId: TENANT_A }, 'room-a'),
    TenantRepositoryContractError,
  );
});

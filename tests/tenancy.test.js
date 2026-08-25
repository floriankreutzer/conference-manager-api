import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TENANT_OWNED_RESOURCE_TYPES,
  TENANT_STATUS,
  isTenantBusinessActive,
  isTenantSessionAvailable,
  normalizeTenant,
} from '../src/tenancy/tenant.js';
import { createTenantContextGuard } from '../src/tenancy/tenant-context.js';
import { createTenantScopedRepository } from '../src/tenancy/tenant-scoped-repository.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function tenant(id, status = TENANT_STATUS.ACTIVE) {
  return {
    id,
    displayName: `Tenant ${id.slice(0, 4)}`,
    status,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
  };
}

function principal(tenantId) {
  return {
    userId: '33333333-3333-4333-8333-333333333333',
    tenantId,
    providerIdentity: { provider: 'microsoft_entra', reference: 'provider-user' },
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
    session: {
      id: '44444444-4444-4444-8444-444444444444',
      issuedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2026-08-24T00:00:00.000Z',
      securityVersion: 1,
    },
  };
}

function memoryAdapter() {
  const records = new Map();
  const key = (tenantId, id) => `${tenantId}:${id}`;
  return {
    records,
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
    'microsoft365_room_mapping',
    'tenant_onboarding_invitation',
    'tenant_identity_binding',
    'user_identity_binding',
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
  assert.equal(isTenantBusinessActive(tenant(TENANT_A, TENANT_STATUS.READY)), false);
  assert.equal(isTenantBusinessActive(tenant(TENANT_A, TENANT_STATUS.ACTIVE)), true);
});

test('tenant context is resolved only from the authenticated principal tenant', async () => {
  const calls = [];
  const guard = createTenantContextGuard({
    loadTenant: async (tenantId) => {
      calls.push(tenantId);
      return tenant(tenantId);
    },
  });
  const context = await guard.requireActive(principal(TENANT_A));
  assert.equal(context.tenantId, TENANT_A);
  assert.deepEqual(calls, [TENANT_A]);
});

test('disabled or mismatched tenant records fail closed', async () => {
  const suspended = createTenantContextGuard({
    loadTenant: async () => tenant(TENANT_A, TENANT_STATUS.SUSPENDED),
  });
  await assert.rejects(() => suspended.requireKnown(principal(TENANT_A)), /TENANT_SESSION_UNAVAILABLE/);

  const mismatched = createTenantContextGuard({
    loadTenant: async () => tenant(TENANT_B),
  });
  await assert.rejects(() => mismatched.requireKnown(principal(TENANT_A)), /TENANT_CONTEXT_MISMATCH/);
});

test('tenant-scoped repository isolates read, update and delete by construction', async () => {
  const adapter = memoryAdapter();
  const repository = createTenantScopedRepository(adapter);
  await repository.insertForTenant(TENANT_A, { id: 'shared', value: 'a' });
  await repository.insertForTenant(TENANT_B, { id: 'shared', value: 'b' });

  assert.equal((await repository.findByTenantIdAndId(TENANT_A, 'shared')).value, 'a');
  assert.equal((await repository.findByTenantIdAndId(TENANT_B, 'shared')).value, 'b');
  assert.equal((await repository.listByTenantId(TENANT_A)).length, 1);

  await repository.updateByTenantIdAndId(TENANT_A, 'shared', { value: 'a2' });
  assert.equal((await repository.findByTenantIdAndId(TENANT_A, 'shared')).value, 'a2');
  assert.equal((await repository.findByTenantIdAndId(TENANT_B, 'shared')).value, 'b');

  await repository.deleteByTenantIdAndId(TENANT_A, 'shared');
  assert.equal(await repository.findByTenantIdAndId(TENANT_A, 'shared'), null);
  assert.equal((await repository.findByTenantIdAndId(TENANT_B, 'shared')).value, 'b');
});

test('tenant-scoped repository rejects tenant-field manipulation and guessed invalid IDs', async () => {
  const adapter = memoryAdapter();
  const repository = createTenantScopedRepository(adapter);
  await assert.rejects(
    () => repository.insertForTenant(TENANT_A, { id: 'room-1', tenantId: TENANT_B }),
    /RESOURCE_TENANT_FIELD_FORBIDDEN/,
  );
  await assert.rejects(
    () => repository.updateByTenantIdAndId(TENANT_A, 'room-1', { tenant_id: TENANT_B }),
    /RESOURCE_TENANT_FIELD_FORBIDDEN/,
  );
  await assert.rejects(
    () => repository.findByTenantIdAndId('not-a-tenant', 'room-1'),
    /TENANT_ID_INVALID/,
  );
});

test('concurrent tenants may use the same resource ID without sharing records', async () => {
  const adapter = memoryAdapter();
  const repository = createTenantScopedRepository(adapter);
  await Promise.all([
    repository.insertForTenant(TENANT_A, { id: 'room-1', value: 'tenant-a' }),
    repository.insertForTenant(TENANT_B, { id: 'room-1', value: 'tenant-b' }),
  ]);
  const [left, right] = await Promise.all([
    repository.findByTenantIdAndId(TENANT_A, 'room-1'),
    repository.findByTenantIdAndId(TENANT_B, 'room-1'),
  ]);
  assert.equal(left.value, 'tenant-a');
  assert.equal(right.value, 'tenant-b');
});

test('repository adapter tenant leakage is detected as a server contract violation', async () => {
  const repository = createTenantScopedRepository({
    ...memoryAdapter(),
    async findByTenantIdAndId() {
      return { id: 'room-1', tenantId: TENANT_B };
    },
  });
  await assert.rejects(
    () => repository.findByTenantIdAndId(TENANT_A, 'room-1'),
    /RESOURCE_TENANT_MISMATCH/,
  );
});

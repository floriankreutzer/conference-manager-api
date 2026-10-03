import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantCatalogueService } from '../src/application/tenant-catalogue-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';
import { tenantCatalogueRouteKey } from '../src/http/settings/catalogue.js';
import { normalizeTenantCatalogue } from '../src/domain/tenant-catalogue.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CORRELATION = '44444444-4444-4444-8444-444444444444';
const manager = { tenantId: TENANT, userId: USER, roles: ['conference_manager'],
  permissions: ['request:read', 'request:manage', 'tenant:rooms:business:manage', 'tenant:catalogue:manage'] };
const item = { id: 'projector', name: 'Projector', description: null, price: { amountMinor: 1250, currency: 'EUR' },
  active: true, order: 1, siteIds: ['berlin'], roomIds: ['room-a'] };
const document = { schemaVersion: 1, type: 'equipment', rows: [item] };

function fixture() {
  const policy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy: policy });
  const receipts = new Map();
  let revision = 1, writes = 0;
  let configuration = normalizeTenantCatalogue({ services: [], equipment: [], cateringItems: [], cateringPackages: [], roomPrices: [] });
  const repository = {
    async loadCurrent(tenantId) { assert.equal(tenantId, TENANT); return { revision, catalogue: configuration }; },
    async listHistory() { return []; },
    async scopeExists({ tenantId, siteId, roomId }) {
      return tenantId === TENANT && (!siteId || siteId === 'berlin') && (!roomId || roomId === 'room-a');
    },
    async validateCandidateReferences({ tenantId, catalogue }) {
      return tenantId === TENANT && catalogue.equipment.every((entry) =>
        entry.siteIds.every((id) => id === 'berlin') && entry.roomIds.every((id) => id === 'room-a'));
    },
    async replace(value) {
      assert.equal(value.tenantId, TENANT);
      if (value.expectedRevision !== revision) return { status: 'conflict', currentRevision: revision };
      value.auditEventFor({ previous: configuration, next: value.catalogue, nextRevision: revision + 1 });
      configuration = value.catalogue; revision += 1; writes += 1;
      const current = { revision, catalogue: configuration };
      const response = value.bulkResponseFor({ current });
      const receipt = receipts.get(value.bulkReceipt.id);
      receipt.status = 'applied'; receipt.appliedResponse = response;
      return { status: 'bulk_applied', response };
    },
  };
  const service = createTenantCatalogueService({ repository, authorizationPolicy: policy, auditService: audit.service,
    clock: () => Date.parse('2026-10-03T08:00:00Z'), bulkTransferRepository: {
      async create(value) {
        const receipt = { ...value, expiresAt: value.expiresAt.toISOString(), status: 'pending' };
        receipts.set(value.id, receipt); return receipt;
      },
      async load({ tenantId, id }) { const receipt = receipts.get(id); return receipt?.tenantId === tenantId ? receipt : null; },
    } });
  return { service, advance: () => { revision += 1; }, writes: () => writes };
}
const context = { principal: manager, tenantContext: { tenantId: TENANT, status: 'active' },
  correlationId: CORRELATION, type: 'equipment' };

test('Equipment template/export/validate/apply/reload and replay use the existing Catalogue contract', async () => {
  const { service, writes } = fixture();
  for (const operation of ['template', 'export', 'validate', 'apply']) {
    assert.equal(tenantCatalogueRouteKey(`/api/v1/tenant/settings/catalogue/bulk/equipment/${operation}`),
      `tenant_settings_catalogue_bulk_${operation}`);
  }
  assert.deepEqual(await service.bulkTemplate(context), { schemaVersion: 1, type: 'equipment', rows: [] });
  const validation = await service.bulkValidate({ ...context, document });
  assert.equal(validation.valid, true);
  const applied = await service.bulkApply({ ...context, document, receiptId: validation.receipt.id });
  assert.equal(applied.revision, 2);
  assert.deepEqual((await service.bulkExport(context)).document, document);
  assert.deepEqual(await service.bulkApply({ ...context, document, receiptId: validation.receipt.id }), applied);
  assert.equal(writes(), 1);
  assert.equal((await service.bulkValidate({ ...context, document })).changed, false);
});

test('Equipment bulk denies Tenant Admin, Employee and cross-Tenant scope before repository access', async () => {
  const { service } = fixture();
  for (const principal of [
    { ...manager, roles: ['employee'], permissions: ['request:read'] },
    { ...manager, roles: ['tenant_admin'], permissions: ['tenant:configure'] },
    { ...manager, tenantId: FOREIGN },
  ]) {
    await assert.rejects(service.bulkTemplate({ ...context, principal }));
    await assert.rejects(service.bulkValidate({ ...context, principal, document }));
    await assert.rejects(service.bulkApply({ ...context, principal, document, receiptId: CORRELATION }));
  }
});

test('Equipment validation rejects foreign references, duplicate IDs, price/currency manipulation and unknown fields', async () => {
  const { service } = fixture();
  for (const rows of [
    [item, item], [{ ...item, roomIds: ['foreign-room'] }], [{ ...item, siteIds: ['foreign-site'] }],
    [{ ...item, price: { amountMinor: -1, currency: 'EUR' } }],
    [{ ...item, price: { amountMinor: 100, currency: 'XXX' } }], [{ ...item, tenantId: FOREIGN }],
  ]) {
    const result = await service.bulkValidate({ ...context, document: { ...document, rows } });
    assert.equal(result.valid, false); assert.equal(result.receipt, null);
  }
});

test('Equipment receipt cannot apply changed data, a foreign actor, or a concurrent revision', async () => {
  const { service, advance, writes } = fixture();
  const validation = await service.bulkValidate({ ...context, document });
  const input = { ...context, document, receiptId: validation.receipt.id };
  await assert.rejects(
    service.bulkApply({ ...input, document: { ...document, rows: [{ ...item, name: 'Changed' }] } }),
    /TENANT_BULK_RECEIPT_INVALID/);
  await assert.rejects(service.bulkApply({ ...input, principal: { ...manager, userId: FOREIGN } }), /TENANT_BULK_RECEIPT_INVALID/);
  advance(); await assert.rejects(service.bulkApply(input), /TENANT_SETTINGS_REVISION_CONFLICT/);
  assert.equal(writes(), 0);
});

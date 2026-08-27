import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createTenantBulkTransferOperations } from '../src/application/tenant-bulk-transfer-operations.js';
import {
  parseTenantBulkDocument,
  tenantBulkCandidate,
  tenantBulkExport,
  tenantBulkTemplate,
} from '../src/domain/tenant-bulk-transfer.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';

function locations() {
  return {
    sites: [{ id: 'site-a', name: 'Site A', active: true, timeZone: 'Europe/Berlin', address: null }],
    rooms: [{
      id: 'room-a', siteId: 'site-a', name: 'Room A', capacity: 10, active: true,
      floor: null, equipment: [], accessibility: [], serviceIds: [], cateringPackageIds: [],
      floorplanAssetId: null, mediaAssetIds: [],
    }],
  };
}

test('bulk documents are exact, bounded and remain owned by their settings aggregate', () => {
  assert.deepEqual(tenantBulkTemplate('sites', 'locations'), {
    schemaVersion: 1, type: 'sites', rows: [],
  });
  assert.throws(
    () => parseTenantBulkDocument(
      { schemaVersion: 1, type: 'sites', rows: [], tenantId: TENANT_ID },
      { type: 'sites', aggregate: 'locations' },
    ),
    /TENANT_BULK_DOCUMENT_INVALID/,
  );
  assert.throws(
    () => tenantBulkTemplate('services', 'locations'),
    /TENANT_BULK_TYPE_INVALID/,
  );
});

test('bulk receipt migration declares the exact ledger and a fail-closed rollback guard', async () => {
  const up = await readFile(new URL('../migrations/028_tenant_bulk_transfer_receipts.up.sql', import.meta.url), 'utf8');
  const down = await readFile(new URL('../migrations/028_tenant_bulk_transfer_receipts.down.sql', import.meta.url), 'utf8');
  for (const column of [
    'tenant_id', 'actor_user_id', 'aggregate', 'document_type', 'source_revision',
    'payload_sha256', 'status', 'expires_at', 'correlation_id', 'applied_response',
  ]) assert.match(up, new RegExp(`\\b${column}\\b`));
  assert.match(up, /REFERENCES tenants\(id\) ON DELETE CASCADE/);
  assert.match(up, /REFERENCES users\(tenant_id, id\) ON DELETE RESTRICT/);
  assert.match(down, /LOCK TABLE tenant_bulk_transfer_receipts IN ACCESS EXCLUSIVE MODE/);
  assert.match(down, /TENANT_BULK_TRANSFER_RECEIPTS_REQUIRE_REVIEW/);
  assert.match(down, /IF EXISTS \(SELECT 1 FROM tenant_bulk_transfer_receipts LIMIT 1\)/);
});

test('patch import preserves excluded collections and absent rows', () => {
  const current = locations();
  const candidate = tenantBulkCandidate({
    aggregate: 'locations',
    type: 'sites',
    current,
    document: {
      schemaVersion: 1,
      type: 'sites',
      rows: [{ ...current.sites[0], name: 'Updated Site' }],
    },
  });
  assert.equal(candidate.sites[0].name, 'Updated Site');
  assert.deepEqual(candidate.rooms, current.rooms);
  assert.deepEqual(tenantBulkExport('rooms', 'locations', candidate).rows, current.rooms);
});

test('validation applies provider-owned room transition rules before issuing a receipt', async () => {
  const operations = createTenantBulkTransferOperations({
    aggregate: 'locations',
    bulkTransferRepository: { async create() { throw new Error('receipt must not be created'); }, async load() {} },
  });
  const current = locations();
  const result = await operations.validate({
    principal: { userId: USER_ID }, tenantContext: { tenantId: TENANT_ID }, correlationId: CORRELATION_ID,
    type: 'rooms', current: { revision: 1, configuration: current },
    document: { schemaVersion: 1, type: 'rooms', rows: [...current.rooms, { ...current.rooms[0], id: 'room-new' }] },
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'TENANT_ROOM_PROVIDER_IMPORT_REQUIRED');
});

test('validation receipts are actor-bound, expiring and replay their applied response', async () => {
  const receipts = new Map();
  const repository = {
    async create(value) {
      const receipt = {
        ...value,
        status: 'pending',
        expiresAt: value.expiresAt.toISOString(),
        appliedResponse: null,
      };
      receipts.set(value.id, receipt);
      return receipt;
    },
    async load({ id }) { return receipts.get(id) ?? null; },
    async markApplied({ id, response }) {
      const receipt = receipts.get(id);
      if (receipt.status === 'applied') return { status: 'replay', response: receipt.appliedResponse };
      receipt.status = 'applied';
      receipt.appliedResponse = response;
      return { status: 'applied', response };
    },
  };
  const operations = createTenantBulkTransferOperations({
    aggregate: 'locations', bulkTransferRepository: repository,
    clock: () => Date.parse('2026-08-27T12:00:00.000Z'),
  });
  const principal = { userId: USER_ID };
  const tenantContext = { tenantId: TENANT_ID };
  const document = {
    schemaVersion: 1,
    type: 'sites',
    rows: [{ ...locations().sites[0], name: 'Updated' }],
  };
  const validation = await operations.validate({
    principal, tenantContext, correlationId: CORRELATION_ID, type: 'sites', document,
    current: { revision: 1, configuration: locations() },
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.changed, true);
  assert.ok(validation.receipt.id);
  let mutations = 0;
  const apply = () => operations.apply({
    principal, tenantContext, type: 'sites', document, receiptId: validation.receipt.id,
    current: { revision: 1, configuration: locations() },
    update: async ({ bulkReceipt }) => {
      mutations += 1;
      const response = { schemaVersion: 1, revision: 2, configuration: locations() };
      const receipt = receipts.get(bulkReceipt.id);
      receipt.status = 'applied';
      receipt.appliedResponse = response;
      return response;
    },
  });
  const first = await apply();
  const replay = await apply();
  assert.deepEqual(replay, first);
  assert.equal(mutations, 1);
  await assert.rejects(
    operations.apply({
      principal: { userId: '44444444-4444-4444-8444-444444444444' },
      tenantContext, type: 'sites', document, receiptId: validation.receipt.id,
      current: { revision: 1, configuration: locations() }, update: async () => ({}),
    }),
    /TENANT_BULK_RECEIPT_INVALID/,
  );
});

import { createHash, randomUUID } from 'node:crypto';
import { normalizeTenantCatalogue } from './tenant-catalogue.js';
import { normalizeTenantCostAllocation } from './tenant-cost-allocation.js';
import { normalizeTenantLocations } from './tenant-locations.js';

export const TENANT_BULK_SCHEMA_VERSION = 1;
export const TENANT_BULK_MAX_BYTES = 65_536;
export const TENANT_BULK_MAX_ROWS = 1_024;
export const TENANT_BULK_MAX_ERRORS = 100;
export const TENANT_BULK_RECEIPT_TTL_MS = 30 * 60 * 1_000;

export const TENANT_BULK_TYPES = Object.freeze({
  sites: Object.freeze({ aggregate: 'locations', collection: 'sites' }),
  rooms: Object.freeze({ aggregate: 'locations', collection: 'rooms' }),
  services: Object.freeze({ aggregate: 'catalogue', collection: 'services' }),
  'catering-items': Object.freeze({ aggregate: 'catalogue', collection: 'cateringItems' }),
  'catering-packages': Object.freeze({ aggregate: 'catalogue', collection: 'cateringPackages' }),
  'cost-centers': Object.freeze({ aggregate: 'cost_allocation', collection: 'costCenters' }),
});

export class TenantBulkTransferInputError extends Error {
  constructor(code = 'TENANT_BULK_TRANSFER_INVALID') {
    super(code);
    this.name = 'TenantBulkTransferInputError';
    this.code = code;
  }
}

function invalid(code) {
  throw new TenantBulkTransferInputError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
  return value;
}

export function requireTenantBulkType(value, aggregate = null) {
  const definition = TENANT_BULK_TYPES[value];
  if (!definition || (aggregate !== null && definition.aggregate !== aggregate)) {
    invalid('TENANT_BULK_TYPE_INVALID');
  }
  return Object.freeze({ type: value, ...definition });
}

export function tenantBulkTemplate(type, aggregate) {
  requireTenantBulkType(type, aggregate);
  return Object.freeze({ schemaVersion: TENANT_BULK_SCHEMA_VERSION, type, rows: Object.freeze([]) });
}

export function tenantBulkExport(type, aggregate, configuration) {
  const definition = requireTenantBulkType(type, aggregate);
  const rows = configuration?.[definition.collection];
  if (!Array.isArray(rows)) throw new TypeError('TENANT_BULK_EXPORT_CONFIGURATION_INVALID');
  return Object.freeze({
    schemaVersion: TENANT_BULK_SCHEMA_VERSION,
    type,
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
  });
}

export function parseTenantBulkDocument(value, { type, aggregate } = {}) {
  const definition = requireTenantBulkType(type, aggregate);
  const document = exactObject(value, ['schemaVersion', 'type', 'rows'], 'TENANT_BULK_DOCUMENT_INVALID');
  if (document.schemaVersion !== TENANT_BULK_SCHEMA_VERSION || document.type !== type) {
    invalid('TENANT_BULK_DOCUMENT_INVALID');
  }
  if (!Array.isArray(document.rows) || document.rows.length > TENANT_BULK_MAX_ROWS) {
    invalid('TENANT_BULK_ROWS_INVALID');
  }
  const ids = new Set();
  for (const row of document.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('TENANT_BULK_ROW_INVALID');
    const id = row.id;
    if (typeof id !== 'string' || id.length < 1 || ids.has(id)) invalid('TENANT_BULK_ROW_INVALID');
    ids.add(id);
  }
  return Object.freeze({
    definition,
    document: Object.freeze({
      schemaVersion: TENANT_BULK_SCHEMA_VERSION,
      type,
      rows: Object.freeze(document.rows.map((row) => Object.freeze({ ...row }))),
    }),
  });
}

function mergeRows(currentRows, importedRows) {
  const imported = new Map(importedRows.map((row) => [row.id, row]));
  const merged = currentRows.map((row) => imported.get(row.id) ?? row);
  const currentIds = new Set(currentRows.map((row) => row.id));
  merged.push(...importedRows.filter((row) => !currentIds.has(row.id)));
  return merged;
}

export function tenantBulkCandidate({ aggregate, type, current, document }) {
  const parsed = parseTenantBulkDocument(document, { type, aggregate });
  const collection = parsed.definition.collection;
  const proposed = { ...current, [collection]: mergeRows(current[collection], parsed.document.rows) };
  if (aggregate === 'locations') return normalizeTenantLocations(proposed);
  if (aggregate === 'catalogue') return normalizeTenantCatalogue(proposed);
  if (aggregate === 'cost_allocation') return normalizeTenantCostAllocation(proposed);
  throw new TypeError('TENANT_BULK_AGGREGATE_INVALID');
}

export function tenantBulkPayloadHash(document) {
  return createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex');
}

export function newTenantBulkReceipt() {
  return randomUUID();
}

export function sameTenantBulkValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

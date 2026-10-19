import { isInternalUuid } from './identifiers.js';
import { normalizeTenantCatalogue } from './tenant-catalogue.js';

const MAX_ASSIGNMENTS = 400; // Existing canonical bound: 300 items + 100 packages.
const KINDS = new Set(['item', 'package']);

export class CateringCatalogueAssignmentError extends Error {
  constructor(code = 'CATERING_CATALOGUE_ASSIGNMENT_INVALID') {
    super(code);
    this.name = 'CateringCatalogueAssignmentError';
    this.code = code;
  }
}
function invalid(code) { throw new CateringCatalogueAssignmentError(code); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) invalid();
  for (const key of own) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
}
function denseArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let i = 0; i < value.length; i += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  return value;
}
function uuid(value) {
  if (!isInternalUuid(value)) invalid();
  return value.toLowerCase();
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid();
  return value;
}
function key(kind, entryId) { return `${kind}:${entryId}`; }

export function cateringCatalogueAssignmentConnectionIds(value) {
  record(value, ['schemaVersion', 'catalogueRevision', 'assignments']);
  if (value.schemaVersion !== 1) invalid();
  revision(value.catalogueRevision);
  const ids = new Set();
  for (const entry of denseArray(value.assignments, MAX_ASSIGNMENTS)) {
    record(entry, ['kind', 'entryId', 'integrationId']);
    if (!KINDS.has(entry.kind) || typeof entry.entryId !== 'string' || entry.entryId.length < 1 || entry.entryId.length > 128) invalid();
    ids.add(uuid(entry.integrationId));
  }
  return Object.freeze([...ids].sort());
}

// Expected canonical catalogue, revision and same-Tenant connection records must be loaded by
// an independently authorized Manager use case. This value policy neither publishes nor persists.
export function normalizeCateringCatalogueAssignments(value, expected) {
  record(expected, ['tenantId', 'catalogueRevision', 'catalogue', 'connections']);
  const tenantId = uuid(expected.tenantId);
  const expectedRevision = revision(expected.catalogueRevision);
  const catalogue = normalizeTenantCatalogue(expected.catalogue);
  const connections = new Set();
  for (const connection of denseArray(expected.connections, MAX_ASSIGNMENTS)) {
    record(connection, ['tenantId', 'integrationId']);
    if (uuid(connection.tenantId) !== tenantId) invalid('CATERING_CATALOGUE_CONNECTION_SCOPE_INVALID');
    const integrationId = uuid(connection.integrationId);
    if (connections.has(integrationId)) invalid('CATERING_CATALOGUE_CONNECTION_DUPLICATE');
    connections.add(integrationId);
  }
  record(value, ['schemaVersion', 'catalogueRevision', 'assignments']);
  if (value.schemaVersion !== 1) invalid();
  if (revision(value.catalogueRevision) !== expectedRevision) invalid('CATERING_CATALOGUE_REVISION_CONFLICT');
  const entries = new Map([
    ...catalogue.cateringItems.map((entry) => [key('item', entry.id), entry]),
    ...catalogue.cateringPackages.map((entry) => [key('package', entry.id), entry]),
  ]);
  const assigned = new Map();
  const assignments = denseArray(value.assignments, MAX_ASSIGNMENTS).map((entry) => {
    record(entry, ['kind', 'entryId', 'integrationId']);
    if (!KINDS.has(entry.kind) || typeof entry.entryId !== 'string' || !entries.has(key(entry.kind, entry.entryId))) {
      invalid('CATERING_CATALOGUE_ENTRY_UNKNOWN');
    }
    const entryKey = key(entry.kind, entry.entryId);
    if (assigned.has(entryKey)) invalid('CATERING_CATALOGUE_ENTRY_DUPLICATE');
    const integrationId = uuid(entry.integrationId);
    if (!connections.has(integrationId)) invalid('CATERING_CATALOGUE_CONNECTION_UNKNOWN');
    assigned.set(entryKey, integrationId);
    return Object.freeze({ kind: entry.kind, entryId: entry.entryId, integrationId });
  });
  if (assignments.length !== entries.size) invalid('CATERING_CATALOGUE_ASSIGNMENT_INCOMPLETE');
  for (const group of catalogue.cateringPackages) {
    for (const itemId of group.itemIds) {
      if (assigned.get(key('package', group.id)) !== assigned.get(key('item', itemId))) {
        invalid('CATERING_CATALOGUE_PACKAGE_PROVIDER_MISMATCH');
      }
    }
  }
  return Object.freeze({ schemaVersion: 1, tenantId, catalogueRevision: expectedRevision,
    assignments: Object.freeze(assignments.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.entryId.localeCompare(right.entryId))),
  });
}

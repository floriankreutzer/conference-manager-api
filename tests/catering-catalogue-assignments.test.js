import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCateringCatalogueAssignments } from '../src/domain/catering-catalogue-assignments.js';

const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entity = (id, extra = {}) => ({ id, name: id, description: null, active: true, order: 0,
  price: { amountMinor: 100, currency: 'EUR' }, siteIds: [], roomIds: [], ...extra });
function fixture() {
  const expected = { tenantId: uuid(1), catalogueRevision: 7,
    catalogue: { services: [], equipment: [], cateringItems: [entity('coffee'), entity('fruit')],
      cateringPackages: [entity('break', { itemIds: ['coffee'], variants: [] })] },
    connections: [{ tenantId: uuid(1), integrationId: uuid(2) }, { tenantId: uuid(1), integrationId: uuid(3) }] };
  const value = { schemaVersion: 1, catalogueRevision: 7, assignments: [
    { kind: 'item', entryId: 'coffee', integrationId: uuid(2) },
    { kind: 'item', entryId: 'fruit', integrationId: uuid(3) },
    { kind: 'package', entryId: 'break', integrationId: uuid(2) },
  ] };
  return { value, expected };
}

test('canonical Catering ownership is complete, immutable and independent for each configured connection', () => {
  const f = fixture();
  const result = normalizeCateringCatalogueAssignments(f.value, f.expected);
  assert.equal(result.tenantId, uuid(1));
  assert.equal(result.catalogueRevision, 7);
  assert.deepEqual(result.assignments, f.value.assignments);
  f.value.assignments[0].integrationId = uuid(3);
  assert.equal(result.assignments[0].integrationId, uuid(2));
  assert.ok(Object.isFrozen(result.assignments[0]));
  assert.ok(Object.isFrozen(result.assignments));
});

test('a package cannot cross connection boundaries even if its items or package are inactive', () => {
  for (const active of [true, false]) {
    const f = fixture();
    f.expected.catalogue.cateringPackages[0].active = active;
    f.value.assignments[2].integrationId = uuid(3);
    assert.throws(() => normalizeCateringCatalogueAssignments(f.value, f.expected), /PACKAGE_PROVIDER_MISMATCH/);
  }
});

test('duplicate, unknown and missing item/package assignments cannot become complete ownership', () => {
  for (const mutate of [
    (f) => f.value.assignments.push({ ...f.value.assignments[0] }),
    (f) => f.value.assignments.pop(),
    (f) => { f.value.assignments[0].entryId = 'unknown'; },
    (f) => { f.value.assignments[0].kind = 'service'; },
    (f) => { f.value.assignments[0].integrationId = uuid(9); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => normalizeCateringCatalogueAssignments(f.value, f.expected));
  }
});

test('Tenant/revision scope and trusted connection identities fail closed', () => {
  for (const mutate of [
    (f) => { f.expected.connections[0].tenantId = uuid(9); },
    (f) => f.expected.connections.push({ ...f.expected.connections[0] }),
    (f) => { f.value.catalogueRevision = 6; },
    (f) => { f.value.catalogueRevision = 8; },
    (f) => { f.value.catalogueRevision = 0; },
    (f) => { f.value.catalogueRevision = Number.MAX_SAFE_INTEGER; },
    (f) => { f.value.tenantId = uuid(9); },
    (f) => { f.value.assignments[0].providerId = 'untrusted'; },
    (f) => { f.value.assignments[0].credentials = 'untrusted'; },
    (f) => { f.expected.connections[0].integrationId = 'untrusted'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => normalizeCateringCatalogueAssignments(f.value, f.expected));
  }
});

test('array/property/getter/prototype ambiguity is rejected without executing submitted accessors', () => {
  const f = fixture();
  for (const assignments of [new Array(3), Object.assign([], { hidden: true }),
    Object.defineProperty([null], '0', { enumerable: true, get() { throw new Error('GETTER_EXECUTED'); } })]) {
    assert.throws(() => normalizeCateringCatalogueAssignments({ ...f.value, assignments }, f.expected),
      { name: 'CateringCatalogueAssignmentError' });
  }
  for (const value of [Object.assign(Object.create({}), f.value),
    { ...f.value, [Symbol('unknown')]: true }, { ...f.value, schemaVersion: 2 }]) {
    assert.throws(() => normalizeCateringCatalogueAssignments(value, f.expected));
  }
});

test('the full existing 300-item/100-package catalogue bound remains assignable without reducing baseline capacity', () => {
  const expected = { tenantId: uuid(1), catalogueRevision: 1,
    connections: [{ tenantId: uuid(1), integrationId: uuid(2) }], catalogue: {
      services: [], equipment: [], cateringItems: Array.from({ length: 300 }, (_, i) => entity(`item-${i}`)),
      cateringPackages: Array.from({ length: 100 }, (_, i) => entity(`package-${i}`, { itemIds: ['item-0'], variants: [] })),
    } };
  const assignments = [...expected.catalogue.cateringItems.map((entry) => ({ kind: 'item', entryId: entry.id, integrationId: uuid(2) })),
    ...expected.catalogue.cateringPackages.map((entry) => ({ kind: 'package', entryId: entry.id, integrationId: uuid(2) }))];
  const value = { schemaVersion: 1, catalogueRevision: 1, assignments };
  assert.equal(normalizeCateringCatalogueAssignments(value, expected).assignments.length, 400);
  assert.throws(() => normalizeCateringCatalogueAssignments({ ...value, assignments: [...assignments, assignments[0]] }, expected));
});

test('empty canonical catalogues are valid without creating or activating an artificial provider', () => {
  const result = normalizeCateringCatalogueAssignments({ schemaVersion: 1, catalogueRevision: 1, assignments: [] },
    { tenantId: uuid(1), catalogueRevision: 1, connections: [],
      catalogue: { services: [], equipment: [], cateringItems: [], cateringPackages: [] } });
  assert.deepEqual(result.assignments, []);
});

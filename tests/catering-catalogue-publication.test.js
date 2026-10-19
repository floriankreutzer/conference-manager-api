import assert from 'node:assert/strict';
import test from 'node:test';
import { planCateringCataloguePublication as plan,
  normalizeCateringCataloguePublicationCommand as normalizeCommand } from '../src/domain/catering-catalogue-publication.js';

const tenantId = 'f0000000-0000-4000-8000-000000000001';
const integrationId = 'f0000000-0000-4000-8000-000000000002';
const other = 'f0000000-0000-4000-8000-000000000003';
const money = (amountMinor) => ({ amountMinor, currency: 'EUR' });
const canonical = (id) => ({ id, name: `Existing ${id}`, description: null, price: money(500), active: true,
  order: 0, siteIds: [], roomIds: [] });
const product = (id) => ({ id, name: `Received ${id}`, description: 'Synthetic supplier source', providerPrice: money(250) });
function expected() {
  return { tenantId, integrationId, sourceRevision: 2, configurationRevision: 3, catalogueRevision: 4,
    assignmentRevision: 5, publicationRevision: 0,
    source: { schemaVersion: 1, sourceVersion: 'supplier-2', items: [product('coffee')],
      packages: [{ ...product('break'), itemIds: ['coffee'], variants: [product('standard')] }],
      terms: { minimumLeadTimeMinutes: 120, minimumOrderValue: null, changeCutoffMinutes: 60, cancelCutoffMinutes: null } },
    catalogue: { services: [canonical('service')], equipment: [canonical('equipment')], roomPrices: [{ roomId: 'room', price: money(900) }],
      cateringItems: [canonical('external')],
      cateringPackages: [{ ...canonical('external-package'), itemIds: ['external'], variants: [] }] },
    assignments: [{ kind: 'item', entryId: 'external', integrationId: other },
      { kind: 'package', entryId: 'external-package', integrationId: other }],
    connections: [{ tenantId, integrationId }, { tenantId, integrationId: other }], previousBindings: [] };
}
const mapped = (sourceId, entryId = sourceId) => ({ sourceId, entryId, price: money(700), active: true, order: 1,
  siteIds: ['site'], roomIds: ['room'] });
function command() {
  return { schemaVersion: 1, commandId: 'f0000000-0000-4000-8000-000000000004',
    expectedSourceRevision: 2, expectedConfigurationRevision: 3, expectedCatalogueRevision: 4,
    expectedAssignmentRevision: 5, expectedPublicationRevision: 0, items: [mapped('coffee','our-coffee')],
    packages: [{ ...mapped('break','our-break'), variants: [{ sourceId: 'standard', entryId: 'our-standard',
      price: money(850), active: true, order: 1 }] }] };
}
function published() {
  const input = expected(); const result = plan(command(),input);
  return { ...input, catalogue: result.catalogue, assignments: result.assignments, previousBindings: result.bindings,
    catalogueRevision: result.catalogueRevision, assignmentRevision: result.assignmentRevision,
    publicationRevision: result.publicationRevision };
}
function subsequent(input) {
  return { ...command(), expectedCatalogueRevision: input.catalogueRevision,
    expectedAssignmentRevision: input.assignmentRevision, expectedPublicationRevision: input.publicationRevision };
}

test('review chooses prices, applicability and same-provider components while preserving unrelated catalogue and inputs', () => {
  const input = expected(); const intent = command(); const before = JSON.stringify([input,intent]); const result = plan(intent,input);
  assert.equal(JSON.stringify([input,intent]),before);
  assert.deepEqual(result.catalogue.services,input.catalogue.services);
  assert.deepEqual(result.catalogue.equipment,input.catalogue.equipment);
  assert.deepEqual(result.catalogue.roomPrices,input.catalogue.roomPrices);
  assert.deepEqual(result.catalogue.cateringItems.find((entry) => entry.id === 'external'),input.catalogue.cateringItems[0]);
  const item = result.catalogue.cateringItems.find((entry) => entry.id === 'our-coffee');
  assert.equal(item.name,'Received coffee'); assert.equal(item.price.amountMinor,700);
  assert.notEqual(item.price.amountMinor,input.source.items[0].providerPrice.amountMinor);
  assert.deepEqual(item.siteIds,['site']); assert.deepEqual(item.roomIds,['room']);
  const group = result.catalogue.cateringPackages.find((entry) => entry.id === 'our-break');
  assert.deepEqual(group.itemIds,['our-coffee']); assert.equal(group.variants[0].price.amountMinor,850);
  assert.equal(result.catalogueRevision,5); assert.equal(result.assignmentRevision,6); assert.equal(result.publicationRevision,1);
  assert.deepEqual(result.bindings.find((entry) => entry.kind === 'package').variants,[{ entryId: 'our-standard', sourceId: 'standard' }]);
  assert.equal(Object.isFrozen(result.catalogue.cateringItems[0].price),true);
  assert.equal(Object.isFrozen(result.bindings[0]),true);
  assert.doesNotMatch(JSON.stringify(result),/providerPrice|available|credential|receipt|approved/);
  intent.items[0].price.amountMinor = 1; input.source.items[0].name = 'mutated'; assert.equal(item.price.amountMinor,700);
  assert.equal(item.name,'Received coffee');
});

test('received unknown costs can be reviewed with explicit independent prices without becoming free or available', () => {
  const input = expected(); input.source.items[0].providerPrice = null; input.source.packages[0].providerPrice = null;
  const result = plan(command(),input);
  assert.equal(result.catalogue.cateringItems.find((entry) => entry.id === 'our-coffee').price.amountMinor,700);
  assert.equal(input.source.items[0].providerPrice,null); assert.equal(Object.hasOwn(result,'availability'),false);
  const intent = command(); delete intent.items[0].price; assert.throws(() => plan(intent,input),/INVALID/);
});

test('unreviewed entries stay absent and an empty replacement retires only previously published own offers, preserving history', () => {
  const input = published(); const before = JSON.stringify(input); input.source.items.push(product('unreviewed'));
  const snapshot = JSON.stringify(input.catalogue); const intent = subsequent(input); intent.items = []; intent.packages = [];
  const result = plan(intent,input);
  assert.equal(result.catalogue.cateringItems.some((entry) => entry.id === 'unreviewed'),false);
  assert.equal(result.catalogue.cateringItems.find((entry) => entry.id === 'our-coffee').active,false);
  assert.equal(result.catalogue.cateringItems.find((entry) => entry.id === 'external').active,true);
  const group = result.catalogue.cateringPackages.find((entry) => entry.id === 'our-break');
  assert.equal(group.active,false); assert.equal(group.variants[0].active,false); assert.deepEqual(group.itemIds,['our-coffee']);
  assert.deepEqual(result.bindings,[]); assert.equal(JSON.stringify(input.catalogue),snapshot);
  assert.ok(before.includes('"active":true'));
});

test('removing a reviewed variant preserves its historical identifier as inactive instead of deleting it', () => {
  const input = published(); const intent = subsequent(input); intent.packages[0].variants = [];
  const result = plan(intent,input); const group = result.catalogue.cateringPackages.find((entry) => entry.id === 'our-break');
  assert.equal(group.variants.length,1); assert.equal(group.variants[0].id,'our-standard'); assert.equal(group.variants[0].active,false);
  assert.deepEqual(result.bindings.find((entry) => entry.kind === 'package').variants,[]);
});

test('review cannot steal another provider offer, omit package component review or activate invalid retired legacy dependencies', () => {
  let input = expected(); let intent = command(); intent.items[0].entryId = 'external';
  assert.throws(() => plan(intent,input),/OWNER_CONFLICT/);
  intent = command(); intent.items = []; assert.throws(() => plan(intent,input),/COMPONENT_UNREVIEWED/);
  intent = command(); intent.items[0].active = false; assert.throws(() => plan(intent,input),/CATALOGUE_CONFLICT/);
  input = published(); input.catalogue = structuredClone(input.catalogue);
  input.catalogue.cateringPackages.push({ ...canonical('legacy'), itemIds: ['our-coffee'], variants: [] });
  input.assignments = [...input.assignments,{ kind: 'package', entryId: 'legacy', integrationId }];
  intent = subsequent(input); intent.items = []; intent.packages = [];
  assert.throws(() => plan(intent,input),/CATALOGUE_CONFLICT/);
});

test('a stale previous provider binding cannot deactivate an offer after deliberate ownership remapping', () => {
  const input = published(); input.assignments = input.assignments.map((entry) => ({ ...entry, integrationId: other }));
  const intent = subsequent(input); intent.items = []; intent.packages = [];
  const result = plan(intent,input);
  assert.equal(result.catalogue.cateringItems.find((entry) => entry.id === 'our-coffee').active,true);
  assert.equal(result.catalogue.cateringPackages.find((entry) => entry.id === 'our-break').active,true);
  assert.throws(() => plan(subsequent(input),input),/OWNER_CONFLICT/);
});

test('all review revisions and independent Tenant/connection scope are exact, with no supplier authority override', () => {
  for (const name of ['Source','Configuration','Catalogue','Assignment','Publication']) {
    const intent = command(); intent[`expected${name}Revision`]++;
    assert.throws(() => plan(intent,expected()),/REVISION_CONFLICT/);
  }
  for (const change of [{ tenantId },{ published: true },{ approved: true },{ schemaVersion: 2 },{ commandId: 'arbitrary' }]) {
    assert.throws(() => plan({ ...command(), ...change },expected()),/INVALID/);
  }
  const input = expected(); input.connections[0].tenantId = 'f0000000-0000-4000-8000-000000000009';
  assert.throws(() => plan(command(),input),/SCOPE_INVALID/);
});

test('ambiguous mapping shapes, getters, duplicates and forged product fields fail closed before they can influence a review', () => {
  for (const change of [
    (value) => { value.items.push(value.items[0]); },
    (value) => { value.items[0].providerPrice = money(1); },
    (value) => { value.items[0].name = 'unreviewed replacement'; },
    (value) => { value.items[0].siteIds = ['site','site']; },
    (value) => { value.items[0].price = { ...money(1), approval: true }; },
    (value) => { value.items[0].sourceId = 'unknown'; },
    (value) => { value.packages[0].variants[0].sourceId = 'unknown'; },
    (value) => { value.items = Array(1); },
  ]) { const value = command(); change(value); assert.throws(() => plan(value,expected())); }
  let reads = 0; const value = command(); Object.defineProperty(value.items[0],'price',{
    enumerable: true, get() { reads++; return money(1); } });
  assert.throws(() => plan(value,expected()),/INVALID/); assert.equal(reads,0);
});


test('first publication preserves full300/100/20 capacity without requiring a synthetic prior assignment revision', () => {
  const input = expected(); input.catalogue.cateringItems = []; input.catalogue.cateringPackages = [];
  input.assignmentRevision = 0; input.assignments = [];
  input.source.items = Array.from({ length: 300 }, (_, i) => product(`item-${i}`));
  input.source.packages = Array.from({ length: 100 }, (_, i) => ({ ...product(`package-${i}`),
    itemIds: input.source.items.map((entry) => entry.id),
    variants: Array.from({ length: 20 }, (_, j) => product(`variant-${j}`)) }));
  const intent = command(); intent.expectedAssignmentRevision = 0;
  intent.items = input.source.items.map((entry) => mapped(entry.id));
  intent.packages = input.source.packages.map((entry) => ({ ...mapped(entry.id),
    variants: entry.variants.map((variant) => ({ sourceId: variant.id, entryId: variant.id,
      price: money(999), active: true, order: 0 })) }));
  const result = plan(intent,input);
  assert.equal(result.catalogue.cateringItems.length,300); assert.equal(result.catalogue.cateringPackages.length,100);
  assert.equal(result.catalogue.cateringPackages[0].variants.length,20); assert.equal(result.assignments.length,400);
  assert.equal(result.assignmentRevision,1); assert.equal(result.bindings.length,400);
  input.assignmentRevision = Number.MAX_SAFE_INTEGER - 1;
  assert.throws(() => plan(intent,input),/INVALID/);
});

test('retained variant history cannot overflow canonical capacity through replacement and every revision remains bounded', () => {
  const input = published(); input.source.packages[0].variants = Array.from({ length: 20 }, (_, i) => product(`new-${i}`));
  const intent = subsequent(input);
  intent.packages[0].variants = input.source.packages[0].variants.map((entry) => ({ sourceId: entry.id, entryId: entry.id,
    price: money(123), active: true, order: 0 }));
  assert.throws(() => plan(intent,input),/CATALOGUE_CONFLICT/);
  for (const field of ['sourceRevision','configurationRevision','catalogueRevision','assignmentRevision','publicationRevision']) {
    const bad = expected(); bad[field] = Number.MAX_SAFE_INTEGER - 1;
    assert.throws(() => plan(command(),bad),/INVALID/);
  }
  const bad = expected(); bad.assignmentRevision = 0; assert.throws(() => plan(command(),bad),/INVALID/);
});


test('review command replay normalization is independent of later source changes and preserves exact commercial intent', () => {
  const original = command(); original.items.push(mapped('fruit','our-fruit'));
  original.packages[0].variants.push({ sourceId: 'alternate',entryId: 'our-alternate',price: money(300),active: true,order: 0 });
  const reordered = structuredClone(original); reordered.items.reverse(); reordered.packages[0].variants.reverse();
  assert.deepEqual(normalizeCommand(original),normalizeCommand(reordered));
  const saved = normalizeCommand(original); assert.equal(Object.isFrozen(saved.packages[0].variants[0].price),true);
  original.items[0].price.amountMinor = 1; assert.equal(saved.items[0].price.amountMinor,700);
  assert.doesNotMatch(JSON.stringify(saved),/tenantId|integrationId|sourcePayload|providerPrice|approved/);
  assert.notDeepEqual(normalizeCommand(original),saved);
  const changed = structuredClone(reordered); changed.expectedSourceRevision++;
  assert.notDeepEqual(normalizeCommand(changed),saved);
});

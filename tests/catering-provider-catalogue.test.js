import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCateringProviderCatalogue as normalize,
  normalizeCateringProviderCatalogueReceiptCommand as command,
  normalizeCateringProviderCatalogueMetadata as metadata } from '../src/domain/catering-provider-catalogue.js';

const scope = { tenantId: 'f0000000-0000-4000-8000-000000000001', integrationId: 'f0000000-0000-4000-8000-000000000002' };
const item = (id = 'coffee') => ({ id, name: 'Synthetic supplier coffee', description: null,
  providerPrice: { amountMinor: 250, currency: 'EUR' } });
const input = () => ({ schemaVersion: 1, sourceVersion: 'supplier-revision-1', items: [item()], packages: [{
  ...item('break'), itemIds: ['coffee'], variants: [item('standard')],
}], terms: { minimumLeadTimeMinutes: 120, minimumOrderValue: { amountMinor: 12000, currency: 'EUR' },
  changeCutoffMinutes: 60, cancelCutoffMinutes: 60 } });

test('provider catalogue preserves independent supplier costs, same-provider components and immutable source values', () => {
  const source = input(); const saved = JSON.stringify(source); const value = normalize(source, scope);
  assert.equal(value.integrationId, scope.integrationId); assert.equal(value.items[0].providerPrice.amountMinor, 250);
  assert.deepEqual(value.packages[0].itemIds, ['coffee']); assert.equal(Object.isFrozen(value.packages[0].variants[0]), true);
  assert.equal(Object.isFrozen(value.terms.minimumOrderValue), true); assert.equal(JSON.stringify(source), saved);
  assert.doesNotMatch(JSON.stringify(value), /published|sellingPrice|approval|credential|available|endpoint/);
  source.items[0].providerPrice.amountMinor = 999; assert.equal(value.items[0].providerPrice.amountMinor, 250);
});

test('unknown prices, source versions and contractual terms remain unknown instead of free or unrestricted', () => {
  const source = input(); source.sourceVersion = null; source.items[0].providerPrice = null;
  source.terms = { minimumLeadTimeMinutes: null, minimumOrderValue: null, changeCutoffMinutes: null, cancelCutoffMinutes: null };
  const value = normalize(source, scope); assert.equal(value.items[0].providerPrice, null);
  assert.deepEqual(value.terms, source.terms); assert.equal(value.sourceVersion, null);
  source.terms.minimumLeadTimeMinutes = 0; assert.equal(normalize(source, scope).terms.minimumLeadTimeMinutes, 0);
});

test('full canonical catalogue capacity is retained without borrowing order receipt limits', () => {
  const source = input(); source.items = Array.from({ length: 300 }, (_, index) => item(`item-${index}`));
  source.packages = Array.from({ length: 100 }, (_, index) => ({ ...item(`package-${index}`),
    itemIds: source.items.map((entry) => entry.id), variants: Array.from({ length: 20 }, (_, number) => item(`variant-${number}`)) }));
  const value = normalize(source, scope); assert.equal(value.items.length, 300); assert.equal(value.packages.length, 100);
  assert.equal(value.packages[0].variants.length, 20); source.items.push(item('extra'));
  assert.throws(() => normalize(source, scope), /INVALID/);
});

test('foreign component references, publication authority, unbounded or ambiguous provider values fail closed', () => {
  for (const change of [{ tenantId: scope.tenantId }, { providerId: 'invented' }, { published: true },
    { schemaVersion: 2 }, { sourceVersion: 'x'.repeat(161) }, { items: [item(),item()] },
    { packages: [{ ...input().packages[0], itemIds: ['foreign-item'] }] },
    { packages: [{ ...input().packages[0], itemIds: ['coffee','coffee'] }] },
    { packages: [{ ...input().packages[0], variants: [item(),item()] }] },
    { items: [{ ...item(), name: '\ud800' }] },
    { items: [{ ...item(), name: 'unsafe\u0085control' }] },
    { items: [{ ...item(), name: '<img src=x>' }] }, { items: [{ ...item(), providerPrice: { amountMinor: -1, currency: 'EUR' } }] },
    { items: [{ ...item(), providerPrice: { amountMinor: 1, currency: 'unknown' } }] },
    { terms: { ...input().terms, cancelCutoffMinutes: -1 } }, { terms: { ...input().terms, minimumLeadTimeMinutes: 525601 } },
    { terms: { ...input().terms, changeCutoffMinutes: 0.5 } }, { terms: { ...input().terms, available: true } }]) {
    assert.throws(() => normalize({ ...input(), ...change }, scope), /INVALID/);
  }
  const sparse = input(); sparse.items = Array(1); assert.throws(() => normalize(sparse, scope), /INVALID/);
  let reads = 0; const getter = input();
  Object.defineProperty(getter, 'items', { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => normalize(getter, scope), /INVALID/); assert.equal(reads, 0);
  assert.throws(() => normalize(input(), { ...scope, integrationId: '../foreign' }), /INVALID/);
  assert.throws(() => normalize(Object.create(input()), scope), /INVALID/);
});

const receipt = () => ({ schemaVersion: 1, commandId: 'f0000000-0000-4000-8000-000000000003', expectedRevision: 0,
  expectedConfigurationRevision: 1, reference: 'Synthetic received supplier price list',
  attestReceivedFromSupplier: true, source: input() });
test('manual receipt requires deliberate attestation, exact revisions and source without accepting publication or Tenant claims', () => {
  const value = command(receipt(), scope); assert.equal(value.expectedRevision, 0);
  assert.equal(value.attestReceivedFromSupplier, true); assert.equal(Object.isFrozen(value.source.terms), true);
  assert.equal(Object.hasOwn(value.source, 'tenantId'), false);
  for (const extra of [{ attestReceivedFromSupplier: false }, { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER - 1 }, { expectedConfigurationRevision: 0 }, { reference: '' },
    { commandId: 'untrusted' }, { published: true }, { tenantId: scope.tenantId }, { source: { ...input(), approved: true } }]) {
    assert.throws(() => command({ ...receipt(), ...extra }, scope), /INVALID/);
  }
});

test('history metadata is bounded and cannot carry supplier product text, unit prices or publication authority', () => {
  const value = { sourceVersion: null, itemCount: 300, packageCount: 100, terms: input().terms };
  assert.equal(metadata(value).itemCount, 300); assert.equal(Object.isFrozen(metadata(value).terms), true);
  for (const extra of [{ itemCount: 301 }, { packageCount: -1 }, { items: input().items },
    { providerPrice: item().providerPrice }, { published: true }]) assert.throws(() => metadata({ ...value, ...extra }), /INVALID/);
});

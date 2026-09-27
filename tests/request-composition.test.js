import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestCompositionInputError,
  RequestCompositionUnavailableError,
  assertRequestV2DraftSnapshotConsistency,
  createRequestV2Snapshot,
  normalizePersistedRequestV2Snapshot,
  normalizeRequestV2Draft,
  priceRequestComposition,
} from '../src/domain/request-composition.js';
import {
  normalizePublicRequest,
  normalizeRequest,
  toPublicRequest,
} from '../src/domain/request.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CAPTURED_AT = '2026-08-27T10:00:00.000Z';

function money(amountMinor, currency = 'EUR') {
  return { amountMinor, currency };
}

function catalogueEntry(id, name, amountMinor, currency = 'EUR') {
  return { id, name, description: null, price: money(amountMinor, currency) };
}

function revisions() {
  return {
    organization: 2,
    locations: 3,
    catalogue: 4,
    bookingPolicies: 5,
    costAllocation: 6,
  };
}

function draft(overrides = {}) {
  return {
    title: 'Annual planning session',
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 2,
    serviceIds: ['service-a'],
    catering: {
      participantCount: 3,
      packageSelection: { packageId: 'package-a', variantId: 'variant-a' },
      itemQuantities: [
        { itemId: 'item-included', quantity: 7 },
        { itemId: 'item-extra', quantity: 2 },
      ],
    },
    dietaryRequirements: null,
    specialRequirements: 'Projector near the lectern',
    allocations: [{ costCenterId: 'center-a', percentageBasisPoints: 10_000 }],
    configurationRevisions: revisions(),
    ...overrides,
  };
}

function room(overrides = {}) {
  return {
    id: 'room-a',
    siteId: 'site-a',
    name: 'Room <A>',
    price: money(10_000),
    ...overrides,
  };
}

function catalogue(overrides = {}) {
  return {
    schemaVersion: 1,
    catalogRevision: 4,
    capturedAt: CAPTURED_AT,
    siteId: 'site-a',
    roomId: 'room-a',
    services: [catalogueEntry('service-a', 'Facilitation', 2_500)],
    equipment: [],
    cateringItems: [
      catalogueEntry('item-extra', 'Coffee refill', 200),
      catalogueEntry('item-included', 'Water', 100),
    ],
    catering: [{
      package: catalogueEntry('package-a', 'Meeting package', 99_999),
      variant: catalogueEntry('variant-a', 'Standard', 300),
      items: [catalogueEntry('item-included', 'Water', 100)],
    }],
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    policyVersionId: 'policy-v1',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evaluatedAt: CAPTURED_AT,
    rules: {
      minimumLeadTimeMinutes: 0,
      maximumAdvanceMinutes: 527_040,
      cancellationWindowMinutes: 0,
      changeWindowMinutes: 0,
      maximumParticipants: 500,
      allowedSiteIds: ['site-a'],
      allowedRoomIds: ['room-a'],
      allowedServiceIds: ['service-a'],
    },
    ...overrides,
  };
}

function allocationSnapshot(totalMinor, currency = 'EUR') {
  return {
    schemaVersion: 1,
    configurationRevision: 6,
    snapshottedAt: CAPTURED_AT,
    model: 'percentage_basis_points',
    totalBasisPoints: 10_000,
    totalMinor,
    allocatedMinor: totalMinor,
    unallocatedMinor: 0,
    currency,
    entries: [{
      costCenterId: 'center-a',
      code: 'CENTER-A',
      name: 'Center <A>',
      group: null,
      percentageBasisPoints: 10_000,
      allocatedMinor: totalMinor,
    }],
  };
}

function validSnapshot() {
  const inputDraft = draft();
  const pricing = priceRequestComposition({
    draft: inputDraft,
    room: room(),
    catalogueSnapshot: catalogue(),
    defaultCurrency: 'EUR',
  });
  return createRequestV2Snapshot({
    draft: inputDraft,
    requestVersion: 1,
    capturedAt: CAPTURED_AT,
    room: room(),
    catalogueSnapshot: catalogue(),
    bookingPolicySnapshot: policy(),
    allocationSnapshot: allocationSnapshot(pricing.totalMinor),
    revisions: revisions(),
    defaultCurrency: 'EUR',
  });
}

function clone(value) {
  return structuredClone(value);
}

function requestRecord(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'REQ-126',
    requesterUserId: USER_ID,
    requesterAttribution: { displayName: 'Persisted requester' },
    schemaVersion: 2,
    version: 1,
    roomId: 'room-a',
    status: 'Submitted',
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 2,
    statusChangedAt: CAPTURED_AT,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    snapshot: validSnapshot(),
    ...overrides,
  };
}

test('Request v2 draft schema is exact, canonical and bounded to 500 participants', () => {
  const normalized = normalizeRequestV2Draft(draft({
    title: '  Annual planning session  ',
    internalParticipants: 500,
    externalParticipants: 0,
    catering: {
      participantCount: 0,
      packageSelection: null,
      itemQuantities: [],
    },
  }));
  assert.equal(normalized.title, 'Annual planning session');
  assert.equal(normalized.internalParticipants, 500);
  assert.deepEqual(normalized.serviceIds, ['service-a']);
  const reverseRevisionOrder = normalizeRequestV2Draft(draft({
    configurationRevisions: {
      costAllocation: 6,
      bookingPolicies: 5,
      catalogue: 4,
      locations: 3,
      organization: 2,
    },
  }));
  assert.deepEqual(
    Object.keys(reverseRevisionOrder.configurationRevisions),
    Object.keys(revisions()),
  );
  assert.equal(
    JSON.stringify(reverseRevisionOrder.configurationRevisions),
    JSON.stringify(normalized.configurationRevisions),
  );
  assert.equal(Object.isFrozen(normalized.catering), true);

  const invalidDrafts = [
    { ...draft(), equipmentIds: ['equipment-a'] },
    { ...draft(), requesterAttribution: { displayName: 'Browser requester' } },
    { ...draft(), actorAttribution: { displayName: 'Browser actor', roleAtAction: 'employee' } },
    { ...draft(), initiatorAttribution: { displayName: 'Browser initiator', roleAtAction: 'employee' } },
    { ...draft(), deciderAttribution: null },
    draft({ internalParticipants: 500, externalParticipants: 1 }),
    draft({ internalParticipants: 0, externalParticipants: 0 }),
    draft({ endsAt: '2026-09-02T10:00:00.001Z' }),
    draft({ startsAt: '2026-09-01T10:00:00Z' }),
    draft({
      catering: {
        participantCount: 5,
        packageSelection: { packageId: 'package-a', variantId: 'variant-a' },
        itemQuantities: [],
      },
    }),
    draft({
      catering: {
        participantCount: 0,
        packageSelection: { packageId: 'package-a', variantId: 'variant-a' },
        itemQuantities: [],
      },
    }),
    draft({ serviceIds: ['service-a', 'service-a'] }),
  ];
  for (const invalidDraft of invalidDrafts) {
    assert.throws(() => normalizeRequestV2Draft(invalidDraft), RequestCompositionInputError);
  }
});

test('pricing charges room and service once, variant per participant and direct items per unit', () => {
  const pricing = priceRequestComposition({
    draft: draft(),
    room: room(),
    catalogueSnapshot: catalogue(),
    defaultCurrency: 'EUR',
  });
  assert.deepEqual(pricing.breakdown, {
    roomMinor: 10_000,
    servicesMinor: 2_500,
    cateringPackageMinor: 900,
    cateringItemsMinor: 400,
  });
  assert.equal(pricing.totalMinor, 13_800);
  assert.equal(pricing.currency, 'EUR');
  assert.equal(pricing.catering.packageSelection.package.price.amountMinor, 99_999);
  assert.equal(pricing.catering.packageSelection.lineTotalMinor, 900);
  assert.deepEqual(
    pricing.catering.items.map((line) => [line.item.id, line.includedByPackage, line.lineTotalMinor]),
    [
      ['item-extra', false, 400],
      ['item-included', true, 0],
    ],
  );
  assert.equal(Object.isFrozen(pricing.catering.items[0].item.price), true);
});

test('pricing rejects mixed currency and non-exact catalogue selections', () => {
  const mixedCatalogue = catalogue();
  mixedCatalogue.services[0].price.currency = 'USD';
  assert.throws(
    () => priceRequestComposition({
      draft: draft(),
      room: room(),
      catalogueSnapshot: mixedCatalogue,
      defaultCurrency: 'EUR',
    }),
    (error) => error instanceof RequestCompositionInputError && error.code === 'REQUEST_MIXED_CURRENCY',
  );

  const descriptiveCurrencyCatalogue = catalogue();
  descriptiveCurrencyCatalogue.catering[0].package.price.currency = 'USD';
  descriptiveCurrencyCatalogue.catering[0].items.push(
    catalogueEntry('item-bundled', 'Bundled biscuit', 100, 'USD'),
  );
  const descriptiveCurrencyPricing = priceRequestComposition({
    draft: draft(),
    room: room(),
    catalogueSnapshot: descriptiveCurrencyCatalogue,
    defaultCurrency: 'EUR',
  });
  assert.equal(descriptiveCurrencyPricing.currency, 'EUR');
  const descriptiveCurrencySnapshot = createRequestV2Snapshot({
    draft: draft(),
    requestVersion: 1,
    capturedAt: CAPTURED_AT,
    room: room(),
    catalogueSnapshot: descriptiveCurrencyCatalogue,
    bookingPolicySnapshot: policy(),
    allocationSnapshot: allocationSnapshot(descriptiveCurrencyPricing.totalMinor),
    revisions: revisions(),
    defaultCurrency: 'EUR',
  });
  assert.equal(
    normalizePersistedRequestV2Snapshot(descriptiveCurrencySnapshot, 1).pricing.currency,
    'EUR',
  );

  const mixedSelectedItemCatalogue = catalogue();
  mixedSelectedItemCatalogue.cateringItems
    .find((entry) => entry.id === 'item-included').price.currency = 'USD';
  mixedSelectedItemCatalogue.catering[0].items[0].price.currency = 'USD';
  const includedCurrencyPricing = priceRequestComposition({
    draft: draft(),
    room: room(),
    catalogueSnapshot: mixedSelectedItemCatalogue,
    defaultCurrency: 'EUR',
  });
  assert.equal(includedCurrencyPricing.currency, 'EUR');
  const includedCurrencySnapshot = createRequestV2Snapshot({
    draft: draft(),
    requestVersion: 1,
    capturedAt: CAPTURED_AT,
    room: room(),
    catalogueSnapshot: mixedSelectedItemCatalogue,
    bookingPolicySnapshot: policy(),
    allocationSnapshot: allocationSnapshot(includedCurrencyPricing.totalMinor),
    revisions: revisions(),
    defaultCurrency: 'EUR',
  });
  assert.equal(
    normalizePersistedRequestV2Snapshot(includedCurrencySnapshot, 1).pricing.currency,
    'EUR',
  );

  const mixedChargedItemCatalogue = catalogue();
  mixedChargedItemCatalogue.cateringItems
    .find((entry) => entry.id === 'item-extra').price.currency = 'USD';
  assert.throws(
    () => priceRequestComposition({
      draft: draft(),
      room: room(),
      catalogueSnapshot: mixedChargedItemCatalogue,
      defaultCurrency: 'EUR',
    }),
    (error) => error instanceof RequestCompositionInputError
      && error.code === 'REQUEST_MIXED_CURRENCY',
  );

  assert.throws(
    () => priceRequestComposition({
      draft: draft(),
      room: room(),
      catalogueSnapshot: catalogue({
        services: [
          catalogueEntry('service-a', 'Facilitation', 2_500),
          catalogueEntry('service-extra', 'Browser extra', 1),
        ],
      }),
      defaultCurrency: 'EUR',
    }),
    RequestCompositionUnavailableError,
  );

  assert.throws(
    () => priceRequestComposition({
      draft: draft(),
      room: room(),
      catalogueSnapshot: catalogue({ equipment: [catalogueEntry('equipment-a', 'Screen', 1)] }),
      defaultCurrency: 'EUR',
    }),
    RequestCompositionInputError,
  );
});

test('an all-zero composition uses the Organization default currency', () => {
  const zeroCatalogue = catalogue({
    services: [catalogueEntry('service-a', 'Facilitation', 0)],
    cateringItems: [
      catalogueEntry('item-extra', 'Coffee refill', 0),
      catalogueEntry('item-included', 'Water', 0),
    ],
    catering: [{
      package: catalogueEntry('package-a', 'Meeting package', 99_999),
      variant: catalogueEntry('variant-a', 'Standard', 0),
      items: [catalogueEntry('item-included', 'Water', 0)],
    }],
  });
  const pricing = priceRequestComposition({
    draft: draft(),
    room: room({ price: money(0) }),
    catalogueSnapshot: zeroCatalogue,
    defaultCurrency: 'CHF',
  });
  assert.equal(pricing.totalMinor, 0);
  assert.equal(pricing.currency, 'CHF');
});

test('immutable Request snapshots preserve validated current configuration facts', () => {
  const snapshot = validSnapshot();
  const normalized = normalizePersistedRequestV2Snapshot(snapshot, 1);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.configurationRevisions.catalogue, 4);
  assert.equal(normalized.pricing.totalMinor, 13_800);
  assert.equal(normalized.allocations.allocatedMinor, 13_800);
  assert.equal(normalized.policy.policyVersionId, 'policy-v1');
  assert.equal(Object.isFrozen(normalized.pricing.catering.packageSelection.variant.price), true);
  assert.throws(() => {
    normalized.pricing.breakdown.roomMinor = 1;
  }, TypeError);

  assert.throws(
    () => createRequestV2Snapshot({
      draft: draft(),
      requestVersion: 1,
      capturedAt: CAPTURED_AT,
      room: room(),
      catalogueSnapshot: catalogue(),
      bookingPolicySnapshot: policy(),
      allocationSnapshot: allocationSnapshot(13_800),
      revisions: { ...revisions(), catalogue: 7 },
      defaultCurrency: 'EUR',
    }),
    RequestCompositionUnavailableError,
  );
});

test('persisted Request snapshot validation fails closed for nested inconsistency', () => {
  const mutations = [
    (snapshot) => { snapshot.pricing.totalMinor += 1; },
    (snapshot) => { snapshot.pricing.services[0].lineTotalMinor += 1; },
    (snapshot) => { snapshot.pricing.catering.items[1].includedByPackage = false; },
    (snapshot) => {
      snapshot.pricing.catering.packageSelection.includedItems[0].price.amountMinor += 1;
    },
    (snapshot) => { snapshot.details.serviceIds = ['service-other']; },
    (snapshot) => { snapshot.allocations.allocatedMinor -= 1; },
    (snapshot) => { snapshot.allocations.entries[0].browserName = 'Untrusted'; },
    (snapshot) => { snapshot.configurationRevisions.costAllocation = 7; },
    (snapshot) => { snapshot.policy.evaluatedAt = '2026-08-27T10:00:01.000Z'; },
    (snapshot) => { snapshot.pricing.breakdown.browserTotal = 13_800; },
    (snapshot) => { snapshot.pricing.services[0].service.price.currency = 'USD'; },
  ];
  for (const mutate of mutations) {
    const snapshot = clone(validSnapshot());
    mutate(snapshot);
    assert.throws(
      () => normalizePersistedRequestV2Snapshot(snapshot, 1),
      RequestCompositionInputError,
    );
  }
});

test('booking-change draft and immutable snapshot must describe the same proposal', () => {
  const snapshot = validSnapshot();
  assert.doesNotThrow(() => assertRequestV2DraftSnapshotConsistency(draft(), snapshot));

  const differentDetails = clone(snapshot);
  differentDetails.details.title = 'Different persisted title';
  assert.throws(
    () => assertRequestV2DraftSnapshotConsistency(draft(), differentDetails),
    (error) => error instanceof RequestCompositionInputError
      && error.code === 'REQUEST_PROPOSAL_SNAPSHOT_INVALID',
  );

  const differentRevisions = clone(snapshot);
  differentRevisions.configurationRevisions.organization += 1;
  assert.throws(
    () => assertRequestV2DraftSnapshotConsistency(draft(), differentRevisions),
    (error) => error instanceof RequestCompositionInputError
      && error.code === 'REQUEST_PROPOSAL_SNAPSHOT_INVALID',
  );

  const differentAllocation = clone(snapshot);
  differentAllocation.allocations.entries[0].costCenterId = 'center-other';
  assert.throws(
    () => assertRequestV2DraftSnapshotConsistency(draft(), differentAllocation),
    (error) => error instanceof RequestCompositionInputError
      && error.code === 'REQUEST_PROPOSAL_SNAPSHOT_INVALID',
  );
});

test('Request records expose v2 facts and explicit legacy unavailability', () => {
  const normalized = normalizeRequest(requestRecord());
  const publicRequest = toPublicRequest(normalized);
  assert.equal(publicRequest.schemaVersion, 2);
  assert.equal(publicRequest.version, 1);
  assert.equal(publicRequest.details.title, 'Annual planning session');
  assert.equal(publicRequest.pricing.totalMinor, 13_800);
  assert.deepEqual(normalizePublicRequest(publicRequest, {
    tenantId: TENANT_ID,
    requesterUserId: USER_ID,
    requesterAttribution: { displayName: 'Persisted requester' },
  }), publicRequest);
  const corrupted = clone(publicRequest);
  corrupted.pricing.totalMinor += 1;
  assert.throws(() => normalizePublicRequest(corrupted, {
    tenantId: TENANT_ID,
    requesterUserId: USER_ID,
    requesterAttribution: { displayName: 'Persisted requester' },
  }), /REQUEST_PUBLIC_RECORD_INVALID/);

  const legacy = toPublicRequest({
    ...requestRecord(),
    schemaVersion: 1,
    snapshot: null,
  });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.details, null);
  assert.equal(legacy.pricing, null);
  assert.equal(legacy.configurationRevisions, null);
  assert.equal(legacy.policy, null);
  assert.equal(legacy.allocations, null);
});

test('Request records reject unknown schemas, mismatched facts and invalid v2 bounds', () => {
  const cases = [
    requestRecord({ schemaVersion: 3 }),
    requestRecord({ version: 2 }),
    requestRecord({ roomId: 'room-other' }),
    requestRecord({ internalParticipants: 500, externalParticipants: 1 }),
    requestRecord({ endsAt: '2026-09-02T10:00:00.001Z' }),
    requestRecord({ startsAt: '2026-09-01T10:00:00Z' }),
    requestRecord({
      snapshot: {
        ...clone(validSnapshot()),
        policy: policy({
          rules: {
            ...policy().rules,
            allowedRoomIds: ['room-other'],
          },
        }),
      },
    }),
  ];
  for (const value of cases) {
    assert.throws(() => normalizeRequest(value), {
      name: 'TypeError',
      message: 'REQUEST_RECORD_INVALID',
    });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBookingChange } from '../src/domain/booking-change.js';
import {
  REQUEST_COMPOSITION_SCHEMA_VERSION,
  REQUEST_COMPOSITION_V3_SCHEMA_VERSION,
  RequestCompositionInputError,
  RequestCompositionUnavailableError,
  SUPPORTED_REQUEST_COMPOSITION_SCHEMA_VERSIONS,
  assertRequestDraftSnapshotConsistency,
  assertRequestV3DraftSnapshotConsistency,
  createRequestCompositionSnapshot,
  createRequestV2Snapshot,
  createRequestV3Snapshot,
  isSupportedRequestCompositionSchemaVersion,
  normalizePersistedRequestCompositionSnapshot,
  normalizePersistedRequestV3Snapshot,
  normalizeRequestCompositionDraft,
  normalizeRequestV2Draft,
  normalizeRequestV3Draft,
  priceRequestComposition,
  priceRequestCompositionForSchemaVersion,
  priceRequestV3Composition,
} from '../src/domain/request-composition.js';
import {
  normalizePublicRequest,
  normalizeRequest,
  toPublicRequest,
} from '../src/domain/request.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANGE_ID = '33333333-3333-4333-8333-333333333333';
const CAPTURED_AT = '2026-08-27T10:00:00.000Z';

function money(amountMinor, currency = 'EUR') {
  return { amountMinor, currency };
}

function catalogueEntry(id, amountMinor, currency = 'EUR') {
  return {
    id,
    name: `Name ${id}`,
    description: null,
    price: money(amountMinor, currency),
  };
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

function v2Draft(overrides = {}) {
  return {
    title: 'Annual planning session',
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 1,
    serviceIds: ['service-a'],
    catering: {
      participantCount: 0,
      packageSelection: null,
      itemQuantities: [],
    },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: revisions(),
    ...overrides,
  };
}

function v3Draft(overrides = {}) {
  return {
    ...v2Draft(),
    equipmentIds: ['equipment-b', 'equipment-a'],
    ...overrides,
  };
}

function room(overrides = {}) {
  return {
    id: 'room-a',
    siteId: 'site-a',
    name: 'Room A',
    price: money(1_000),
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
    services: [catalogueEntry('service-a', 200)],
    equipment: [
      catalogueEntry('equipment-b', 400),
      catalogueEntry('equipment-a', 300),
    ],
    cateringItems: [],
    catering: [],
    ...overrides,
  };
}

function v2Catalogue() {
  return catalogue({ equipment: [] });
}

function policy() {
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
  };
}

function allocationSnapshot(totalMinor, currency = 'EUR') {
  return {
    schemaVersion: 1,
    configurationRevision: 6,
    snapshottedAt: CAPTURED_AT,
    model: 'percentage_basis_points',
    totalBasisPoints: 0,
    totalMinor,
    allocatedMinor: 0,
    unallocatedMinor: totalMinor,
    currency,
    entries: [],
  };
}

function snapshotInput(schemaVersion, draftValue, catalogueSnapshot) {
  const pricing = priceRequestCompositionForSchemaVersion({
    schemaVersion,
    draft: draftValue,
    room: room(),
    catalogueSnapshot,
    defaultCurrency: 'EUR',
  });
  return {
    draft: draftValue,
    requestVersion: 1,
    capturedAt: CAPTURED_AT,
    room: room(),
    catalogueSnapshot,
    bookingPolicySnapshot: policy(),
    allocationSnapshot: allocationSnapshot(pricing.totalMinor),
    revisions: revisions(),
    defaultCurrency: 'EUR',
  };
}

function validV3Snapshot(requestVersion = 1) {
  return createRequestV3Snapshot({
    ...snapshotInput(3, v3Draft(), catalogue()),
    requestVersion,
  });
}

function requestRecord(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'REQ-186',
    requesterUserId: USER_ID,
    requesterAttribution: { displayName: 'Persisted requester' },
    schemaVersion: 3,
    version: 1,
    roomId: 'room-a',
    status: 'Submitted',
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 1,
    statusChangedAt: CAPTURED_AT,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    snapshot: validV3Snapshot(),
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

test('Request v3 is an explicit additive contract while Request v2 remains exact', () => {
  assert.equal(REQUEST_COMPOSITION_SCHEMA_VERSION, 2);
  assert.equal(REQUEST_COMPOSITION_V3_SCHEMA_VERSION, 3);
  assert.deepEqual(SUPPORTED_REQUEST_COMPOSITION_SCHEMA_VERSIONS, [2, 3]);
  assert.equal(isSupportedRequestCompositionSchemaVersion(2), true);
  assert.equal(isSupportedRequestCompositionSchemaVersion(3), true);
  assert.equal(isSupportedRequestCompositionSchemaVersion(4), false);

  const normalized = normalizeRequestV3Draft(v3Draft());
  assert.deepEqual(normalized.equipmentIds, ['equipment-a', 'equipment-b']);
  assert.equal(Object.isFrozen(normalized.equipmentIds), true);
  assert.deepEqual(normalizeRequestCompositionDraft(v3Draft(), 3), normalized);
  assert.deepEqual(normalizeRequestV3Draft(v3Draft({ equipmentIds: [] })).equipmentIds, []);
  const maximumEquipmentIds = Array.from({ length: 200 }, (_, index) => `equipment-${index}`);
  assert.equal(
    normalizeRequestV3Draft(v3Draft({ equipmentIds: maximumEquipmentIds })).equipmentIds.length,
    200,
  );
  assert.throws(() => normalizeRequestV2Draft(v3Draft()), RequestCompositionInputError);

  const { equipmentIds: omitted, ...withoutEquipment } = v3Draft();
  assert.equal(omitted.length, 2);
  const invalidDrafts = [
    withoutEquipment,
    { ...v3Draft(), requesterAttribution: { displayName: 'Browser requester' } },
    { ...v3Draft(), actorAttribution: { displayName: 'Browser actor', roleAtAction: 'employee' } },
    { ...v3Draft(), initiatorAttribution: { displayName: 'Browser initiator', roleAtAction: 'employee' } },
    { ...v3Draft(), deciderAttribution: null },
    v3Draft({ equipmentIds: ['equipment-a', 'equipment-a'] }),
    v3Draft({ equipmentIds: Array.from({ length: 201 }, (_, index) => `equipment-${index}`) }),
    { ...v3Draft(), browserTotal: 1 },
  ];
  for (const invalidDraft of invalidDrafts) {
    assert.throws(() => normalizeRequestV3Draft(invalidDraft), RequestCompositionInputError);
  }
  assert.throws(
    () => normalizeRequestCompositionDraft(v3Draft(), 4),
    (error) => error.code === 'REQUEST_SCHEMA_VERSION_UNSUPPORTED',
  );
});

test('Request v3 pricing charges every selected equipment entry exactly once', () => {
  const pricing = priceRequestV3Composition({
    draft: v3Draft(),
    room: room(),
    catalogueSnapshot: catalogue(),
    defaultCurrency: 'EUR',
  });
  assert.deepEqual(pricing.breakdown, {
    roomMinor: 1_000,
    servicesMinor: 200,
    equipmentMinor: 700,
    cateringPackageMinor: 0,
    cateringItemsMinor: 0,
  });
  assert.equal(pricing.totalMinor, 1_900);
  assert.deepEqual(
    pricing.equipment.map((line) => [
      line.equipment.id,
      line.equipment.price.amountMinor,
      line.lineTotalMinor,
    ]),
    [
      ['equipment-a', 300, 300],
      ['equipment-b', 400, 400],
    ],
  );
  assert.deepEqual(priceRequestCompositionForSchemaVersion({
    schemaVersion: 3,
    draft: v3Draft(),
    room: room(),
    catalogueSnapshot: catalogue(),
    defaultCurrency: 'EUR',
  }), pricing);

  assert.throws(
    () => priceRequestV3Composition({
      draft: v3Draft(),
      room: room(),
      catalogueSnapshot: catalogue({
        equipment: [catalogueEntry('equipment-a', 300)],
      }),
      defaultCurrency: 'EUR',
    }),
    RequestCompositionUnavailableError,
  );
  assert.throws(
    () => priceRequestV3Composition({
      draft: v3Draft(),
      room: room(),
      catalogueSnapshot: catalogue({
        equipment: [
          catalogueEntry('equipment-a', 300),
          catalogueEntry('equipment-a', 300),
        ],
      }),
      defaultCurrency: 'EUR',
    }),
    RequestCompositionInputError,
  );
  assert.throws(
    () => priceRequestV3Composition({
      draft: v3Draft(),
      room: room(),
      catalogueSnapshot: catalogue({
        equipment: [
          catalogueEntry('equipment-a', 300),
          catalogueEntry('equipment-b', 400, 'USD'),
        ],
      }),
      defaultCurrency: 'EUR',
    }),
    (error) => error.code === 'REQUEST_MIXED_CURRENCY',
  );

  const zeroPricing = priceRequestV3Composition({
    draft: v3Draft({ serviceIds: [], equipmentIds: ['equipment-a'] }),
    room: room({ price: money(0, 'USD') }),
    catalogueSnapshot: catalogue({
      services: [],
      equipment: [catalogueEntry('equipment-a', 0, 'USD')],
    }),
    defaultCurrency: 'CHF',
  });
  assert.equal(zeroPricing.totalMinor, 0);
  assert.equal(zeroPricing.currency, 'CHF');
  assert.equal(zeroPricing.breakdown.equipmentMinor, 0);
});

test('Request v3 snapshots are exact, immutable and reject pricing manipulation', () => {
  const snapshot = validV3Snapshot();
  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(snapshot.details.equipmentIds, ['equipment-a', 'equipment-b']);
  assert.equal(snapshot.pricing.breakdown.equipmentMinor, 700);
  assert.equal(snapshot.pricing.totalMinor, 1_900);
  assert.equal(snapshot.allocations.unallocatedMinor, 1_900);
  assert.equal(Object.isFrozen(snapshot.pricing.equipment[0].equipment.price), true);
  assert.deepEqual(normalizePersistedRequestV3Snapshot(snapshot, 1), snapshot);
  assert.deepEqual(normalizePersistedRequestCompositionSnapshot(snapshot, 1), snapshot);
  assert.doesNotThrow(() => assertRequestV3DraftSnapshotConsistency(v3Draft(), snapshot));
  assert.doesNotThrow(() => assertRequestDraftSnapshotConsistency(v3Draft(), snapshot, 3));

  const mutations = [
    (value) => { value.details.equipmentIds = ['equipment-other']; },
    (value) => { value.pricing.equipment[0].lineTotalMinor += 1; },
    (value) => { value.pricing.breakdown.equipmentMinor += 1; },
    (value) => { value.pricing.totalMinor = Number.MAX_SAFE_INTEGER; },
    (value) => { value.pricing.equipment[0].equipment.price.currency = 'USD'; },
    (value) => { value.pricing.equipment[0].browserQuantity = 2; },
    (value) => { value.details.browserEquipment = []; },
  ];
  for (const mutate of mutations) {
    const manipulated = clone(snapshot);
    mutate(manipulated);
    assert.throws(
      () => normalizePersistedRequestV3Snapshot(manipulated, 1),
      RequestCompositionInputError,
    );
  }

  const differentSnapshot = clone(snapshot);
  differentSnapshot.details.equipmentIds = ['equipment-other'];
  assert.throws(
    () => assertRequestV3DraftSnapshotConsistency(v3Draft(), differentSnapshot),
    RequestCompositionInputError,
  );
});

test('versioned dispatch leaves the exact Request v2 snapshot shape unchanged', () => {
  const input = snapshotInput(2, v2Draft(), v2Catalogue());
  const specific = createRequestV2Snapshot(input);
  const dispatched = createRequestCompositionSnapshot({ schemaVersion: 2, ...input });
  assert.deepEqual(dispatched, specific);
  assert.equal('equipmentIds' in specific.details, false);
  assert.equal('equipment' in specific.pricing, false);
  assert.equal('equipmentMinor' in specific.pricing.breakdown, false);
  assert.deepEqual(priceRequestComposition({
    draft: v2Draft(),
    room: room(),
    catalogueSnapshot: v2Catalogue(),
    defaultCurrency: 'EUR',
  }).breakdown, {
    roomMinor: 1_000,
    servicesMinor: 200,
    cateringPackageMinor: 0,
    cateringItemsMinor: 0,
  });

  const v3Input = snapshotInput(3, v3Draft(), catalogue());
  assert.deepEqual(
    createRequestCompositionSnapshot({ schemaVersion: 3, ...v3Input }),
    createRequestV3Snapshot(v3Input),
  );
  assert.throws(
    () => createRequestCompositionSnapshot({ schemaVersion: 4, ...v3Input }),
    (error) => error.code === 'REQUEST_SCHEMA_VERSION_UNSUPPORTED',
  );
});

test('canonical Request and booking-change records explicitly support Request v3', () => {
  const normalized = normalizeRequest(requestRecord());
  const publicRequest = toPublicRequest(normalized);
  assert.equal(publicRequest.schemaVersion, 3);
  assert.deepEqual(publicRequest.details.equipmentIds, ['equipment-a', 'equipment-b']);
  assert.equal(publicRequest.pricing.breakdown.equipmentMinor, 700);
  assert.deepEqual(normalizePublicRequest(publicRequest, {
    tenantId: TENANT_ID,
    requesterUserId: USER_ID,
  }), publicRequest);

  const requestDraft = v3Draft();
  const proposedRequestSnapshot = validV3Snapshot(2);
  const change = normalizeBookingChange({
    tenantId: TENANT_ID,
    id: CHANGE_ID,
    requestId: 'REQ-186',
    initiatorUserId: USER_ID,
    initiatorAttribution: { displayName: 'Persisted requester', roleAtAction: 'employee' },
    deciderAttribution: null,
    status: 'pending',
    roomId: requestDraft.roomId,
    startsAt: requestDraft.startsAt,
    endsAt: requestDraft.endsAt,
    internalParticipants: requestDraft.internalParticipants,
    externalParticipants: requestDraft.externalParticipants,
    baseRequestUpdatedAt: CAPTURED_AT,
    decidedByUserId: null,
    rejectionReason: null,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    requestSchemaVersion: 3,
    baseRequestVersion: 1,
    requestDraft,
    proposedRequestSnapshot,
  });
  assert.equal(change.requestSchemaVersion, 3);
  assert.deepEqual(change.requestDraft.equipmentIds, ['equipment-a', 'equipment-b']);
  assert.equal(change.proposedRequestSnapshot.pricing.breakdown.equipmentMinor, 700);

  const mismatched = clone(proposedRequestSnapshot);
  mismatched.details.equipmentIds = [];
  assert.throws(
    () => normalizeBookingChange({ ...change, proposedRequestSnapshot: mismatched }),
    { name: 'TypeError', message: 'BOOKING_CHANGE_INVALID' },
  );
  assert.throws(
    () => normalizeRequest({ ...requestRecord(), schemaVersion: 2 }),
    { name: 'TypeError', message: 'REQUEST_RECORD_INVALID' },
  );
  assert.throws(
    () => normalizeBookingChange({ ...change, requestSchemaVersion: 4 }),
    { name: 'TypeError', message: 'BOOKING_CHANGE_INVALID' },
  );
});

import { createRequestCompositionSnapshot, priceRequestCompositionForSchemaVersion } from '../../src/domain/request-composition.js';

export const cateringId = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const capturedAt = '2026-10-19T08:00:00.000Z';
const money = (amountMinor) => ({ amountMinor, currency: 'EUR' });
const entry = (id, amountMinor) => ({ id, name: id, description: null, price: money(amountMinor) });
const canonical = (value) => ({ ...value, active: true, order: 0, siteIds: [], roomIds: [] });

export function cateringOrderFixture({ schemaVersion = 2, includedCount = 2, extraCount = 1,
  includedSelection = true, quantity = 2, participants = 3, unitPrice = 100, packagePrice = 300 } = {}) {
  const included = Array.from({ length: includedCount }, (_, n) => entry(`included-${n}`, unitPrice));
  const extras = Array.from({ length: extraCount }, (_, n) => entry(`extra-${n}`, unitPrice));
  const packageEntry = entry('package-a', packagePrice);
  const variant = entry('variant-a', packagePrice);
  const canonicalCatalogue = { services: [], equipment: [], cateringItems: [...included, ...extras].map(canonical),
    cateringPackages: [{ ...canonical(packageEntry), itemIds: included.map((item) => item.id), variants: [
      { ...variant, active: true, order: 0 },
    ] }] };
  const direct = [...(includedSelection ? [included[0]] : []), ...extras];
  const revisions = { organization: 1, locations: 1, catalogue: 4, bookingPolicies: 1, costAllocation: 1 };
  const draft = { title: 'Synthetic conference', roomId: 'room-a', startsAt: '2026-10-20T10:00:00.000Z',
    endsAt: '2026-10-20T11:00:00.000Z', internalParticipants: 500, externalParticipants: 0,
    serviceIds: [], ...(schemaVersion === 3 ? { equipmentIds: [] } : {}),
    catering: { participantCount: participants, packageSelection: { packageId: 'package-a', variantId: 'variant-a' },
      itemQuantities: direct.map((item) => ({ itemId: item.id, quantity })) },
    dietaryRequirements: 'Synthetic dietary note', specialRequirements: 'Synthetic delivery note',
    allocations: [{ costCenterId: 'center-a', percentageBasisPoints: 10000 }], configurationRevisions: revisions };
  const room = { id: 'room-a', siteId: 'site-a', name: 'Synthetic Room', price: money(0) };
  const catalogueSnapshot = { schemaVersion: 1, catalogRevision: 4, capturedAt, siteId: 'site-a', roomId: 'room-a',
    services: [], equipment: [], cateringItems: direct,
    catering: [{ package: packageEntry, variant, items: included }] };
  const pricing = priceRequestCompositionForSchemaVersion({ schemaVersion, draft, room, catalogueSnapshot, defaultCurrency: 'EUR' });
  const snapshot = createRequestCompositionSnapshot({ schemaVersion, draft, requestVersion: 2, capturedAt,
    room, catalogueSnapshot, defaultCurrency: 'EUR', revisions,
    bookingPolicySnapshot: { policyVersionId: 'policy-a', effectiveFrom: '2026-01-01T00:00:00.000Z', evaluatedAt: capturedAt,
      rules: { minimumLeadTimeMinutes: 0, maximumAdvanceMinutes: 527040, cancellationWindowMinutes: 0,
        changeWindowMinutes: 0, maximumParticipants: 500, allowedSiteIds: [], allowedRoomIds: [], allowedServiceIds: [] } },
    allocationSnapshot: { schemaVersion: 1, configurationRevision: 1, snapshottedAt: capturedAt,
      model: 'percentage_basis_points', totalBasisPoints: 10000, totalMinor: pricing.totalMinor,
      allocatedMinor: pricing.totalMinor, unallocatedMinor: 0, currency: 'EUR', entries: [
        { costCenterId: 'center-a', code: 'CENTER-A', name: 'Synthetic Center', group: null,
          percentageBasisPoints: 10000, allocatedMinor: pricing.totalMinor },
      ] } });
  let sequence = 100;
  return { request: { tenantId: cateringId(1), id: 'request-a', requesterUserId: cateringId(2),
    requesterAttribution: { displayName: 'Synthetic Requester' }, schemaVersion, version: 2, roomId: 'room-a',
    status: 'Confirmed', statusReason: null, startsAt: draft.startsAt, endsAt: draft.endsAt,
    internalParticipants: 500, externalParticipants: 0, createdAt: capturedAt, updatedAt: capturedAt,
    statusChangedAt: capturedAt, snapshot },
  assignmentRevision: 3, canonicalCatalogue,
  ownership: { schemaVersion: 1, catalogueRevision: 4, assignments: [
    ...included.map((item) => ({ kind: 'item', entryId: item.id, integrationId: cateringId(3) })),
    ...extras.map((item) => ({ kind: 'item', entryId: item.id, integrationId: cateringId(4) })),
    { kind: 'package', entryId: 'package-a', integrationId: cateringId(3) },
  ] }, connections: [3, 4].map((n) => ({ tenantId: cateringId(1), integrationId: cateringId(n) })),
  orderIdFactory: () => cateringId(sequence++), positionIdFactory: () => cateringId(sequence++) };
}

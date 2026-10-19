import { isInternalUuid } from './identifiers.js';
import { normalizeRequest } from './request.js';
import { REQUEST_STATUS } from './request-workflow.js';
import { normalizeTenantCatalogue } from './tenant-catalogue.js';
import { normalizeCateringCatalogueAssignments } from './catering-catalogue-assignments.js';
import { normalizeCateringOrderTotal } from './catering-order-money.js';
import { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';

export { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';

function invalid() { throw new TypeError('CATERING_ORDER_SNAPSHOT_INVALID'); }
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, frozenCopy(entry)]),
  ));
  return value;
}
function sameEntry(snapshot, canonical) {
  return canonical && ['id', 'name', 'description'].every((key) => snapshot[key] === canonical[key])
    && snapshot.price.amountMinor === canonical.price.amountMinor && snapshot.price.currency === canonical.price.currency;
}

// All inputs are independently loaded by an authorized use case. This pure
// projection neither authenticates a caller nor releases/enqueues an order.
export function createCateringOrderSnapshots({ request: requestValue, assignmentRevision,
  ownership, canonicalCatalogue, connections, orderIdFactory, positionIdFactory } = {}) {
  if (!Number.isSafeInteger(assignmentRevision) || assignmentRevision < 1 || assignmentRevision >= Number.MAX_SAFE_INTEGER
    || typeof orderIdFactory !== 'function' || typeof positionIdFactory !== 'function') invalid();
  const request = normalizeRequest(requestValue);
  if (request.status !== REQUEST_STATUS.CONFIRMED || request.snapshot === null) invalid();
  const canonical = normalizeTenantCatalogue(canonicalCatalogue);
  const catalogueRevision = request.snapshot.configurationRevisions.catalogue;
  const normalizedOwnership = normalizeCateringCatalogueAssignments(ownership, {
    tenantId: request.tenantId, catalogueRevision, catalogue: canonical, connections,
  });
  const owners = new Map(normalizedOwnership.assignments.map((entry) => [`${entry.kind}:${entry.entryId}`, entry.integrationId]));
  const itemById = new Map(canonical.cateringItems.map((entry) => [entry.id, entry]));
  const groups = new Map();
  const ids = new Set();
  function allocate(factory, context) {
    const value = factory(Object.freeze(context));
    if (!isInternalUuid(value)) invalid();
    const normalized = value.toLowerCase();
    if (ids.has(normalized)) invalid();
    ids.add(normalized);
    return normalized;
  }
  function addPosition(kind, entry, quantity, lineTotalMinor, packageDetails = null) {
    const integrationId = owners.get(`${kind}:${entry.id}`);
    if (!integrationId) invalid();
    if (!groups.has(integrationId)) groups.set(integrationId, []);
    const positionId = allocate(positionIdFactory, { tenantId: request.tenantId, requestId: request.id,
      requestVersion: request.version, integrationId, kind, entryId: entry.id });
    groups.get(integrationId).push({ positionId, kind, entryId: entry.id, name: entry.name,
      description: entry.description, quantity, unitPrice: entry.price, conferenceLineTotalMinor: lineTotalMinor, packageDetails });
  }
  const catering = request.snapshot.pricing.catering;
  const selectedPackage = catering.packageSelection;
  if (selectedPackage !== null) {
    const packageEntry = canonical.cateringPackages.find((entry) => entry.id === selectedPackage.package.id);
    const variant = packageEntry?.variants.find((entry) => entry.id === selectedPackage.variant.id);
    if (!sameEntry(selectedPackage.package, packageEntry) || !sameEntry(selectedPackage.variant, variant)
      || selectedPackage.includedItems.length !== packageEntry.itemIds.length
      || selectedPackage.includedItems.some((entry) => !packageEntry.itemIds.includes(entry.id)
        || !sameEntry(entry, itemById.get(entry.id)))) invalid();
    // One commercial package position retains every included component. A direct
    // selection already included by the package is retained as descriptive input,
    // never duplicated as another supplier charge or invented quantity.
    addPosition('package', selectedPackage.package, selectedPackage.participantCount, selectedPackage.lineTotalMinor, {
      variant: selectedPackage.variant, includedItems: selectedPackage.includedItems,
      includedSelections: catering.items.filter((entry) => entry.includedByPackage)
        .map((entry) => ({ itemId: entry.item.id, quantity: entry.quantity })),
    });
    const line = groups.get(owners.get(`package:${selectedPackage.package.id}`)).at(-1);
    line.unitPrice = selectedPackage.variant.price;
  }
  for (const line of catering.items) {
    if (!sameEntry(line.item, itemById.get(line.item.id))) invalid();
    if (!line.includedByPackage) addPosition('item', line.item, line.quantity, line.lineTotalMinor);
  }
  const expectedTotal = catering.items.reduce((sum, entry) => sum + entry.lineTotalMinor, selectedPackage?.lineTotalMinor ?? 0);
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal !== request.snapshot.pricing.breakdown.cateringItemsMinor
    + request.snapshot.pricing.breakdown.cateringPackageMinor) invalid();
  let total = 0;
  let positionCount = 0;
  const orders = [...groups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([integrationId, positions]) => {
    const orderId = allocate(orderIdFactory, { tenantId: request.tenantId, requestId: request.id,
      requestVersion: request.version, integrationId });
    const amountMinor = positions.reduce((sum, entry) => sum + entry.conferenceLineTotalMinor, 0);
    const conferencePrice = normalizeCateringOrderTotal({ amountMinor, currency: request.snapshot.pricing.currency });
    total += amountMinor; positionCount += positions.length;
    return { schemaVersion: 1, tenantId: request.tenantId, integrationId, orderId, orderVersion: 1,
      requestId: request.id, requestVersion: request.version, assignmentRevision, catalogueRevision,
      sourceCapturedAt: request.snapshot.capturedAt, startsAt: request.startsAt, endsAt: request.endsAt,
      room: { id: request.roomId, siteId: request.snapshot.pricing.room.siteId, name: request.snapshot.pricing.room.name },
      title: request.snapshot.details.title, participantCount: catering.participantCount,
      dietaryRequirements: request.snapshot.details.dietaryRequirements,
      specialRequirements: request.snapshot.details.specialRequirements,
      positions, conferencePrice, providerCost: null };
  });
  if (total !== expectedTotal || positionCount > CATERING_MAX_ORDER_POSITIONS) invalid();
  return frozenCopy(orders);
}

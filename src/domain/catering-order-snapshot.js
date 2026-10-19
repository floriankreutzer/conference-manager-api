import { isInternalUuid } from './identifiers.js';
import { normalizeRequest } from './request.js';
import { REQUEST_STATUS } from './request-workflow.js';
import { normalizeCateringOrderTotal } from './catering-order-money.js';
import { createCateringRequestCommercialSelection } from './catering-request-commercial-selection.js';

export { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';

function invalid() { throw new TypeError('CATERING_ORDER_SNAPSHOT_INVALID'); }
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, frozenCopy(entry)]),
  ));
  return value;
}
// All inputs are independently loaded by an authorized use case. This pure
// projection neither authenticates a caller nor releases/enqueues an order.
export function createCateringOrderSnapshots({ request: requestValue, assignmentRevision,
  ownership, canonicalCatalogue, connections, orderIdFactory, positionIdFactory, orderVersion = 1, onlyIntegrationId = null } = {}) {
  if (!Number.isSafeInteger(assignmentRevision) || assignmentRevision < 1 || assignmentRevision >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(orderVersion) || orderVersion < 1 || orderVersion >= Number.MAX_SAFE_INTEGER
    || (onlyIntegrationId !== null && !isInternalUuid(onlyIntegrationId))
    || typeof orderIdFactory !== 'function' || typeof positionIdFactory !== 'function') invalid();
  const request = normalizeRequest(requestValue);
  if (request.status !== REQUEST_STATUS.CONFIRMED || request.snapshot === null) invalid();
  const catalogueRevision=request.snapshot.configurationRevisions.catalogue;
  const selection=createCateringRequestCommercialSelection({request,ownership,canonicalCatalogue,connections});
  const groups=new Map(selection.map(({integrationId,positions})=>[integrationId,positions]));
  const ids = new Set();
  function allocate(factory, context) {
    const value = factory(Object.freeze(context));
    if (!isInternalUuid(value)) invalid();
    const normalized = value.toLowerCase();
    if (ids.has(normalized)) invalid();
    ids.add(normalized);
    return normalized;
  }
  const selectedIntegration = onlyIntegrationId?.toLowerCase() ?? null;
  if (selectedIntegration !== null && !groups.has(selectedIntegration)) invalid();
  const orders = [...groups].filter(([integrationId]) => selectedIntegration === null || integrationId === selectedIntegration)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([integrationId, sourcePositions]) => {
    const positions = sourcePositions.map((position) => ({ ...position,
      positionId: allocate(positionIdFactory, { tenantId: request.tenantId, requestId: request.id,
        requestVersion: request.version, orderVersion, integrationId, kind: position.kind, entryId: position.entryId }),
    }));
    const orderId = allocate(orderIdFactory, { tenantId: request.tenantId, requestId: request.id,
      requestVersion: request.version, orderVersion, integrationId });
    const amountMinor = positions.reduce((sum, entry) => sum + entry.conferenceLineTotalMinor, 0);
    const conferencePrice = normalizeCateringOrderTotal({ amountMinor, currency: request.snapshot.pricing.currency });
    return { schemaVersion: 1, tenantId: request.tenantId, integrationId, orderId, orderVersion,
      requestId: request.id, requestVersion: request.version, assignmentRevision, catalogueRevision,
      sourceCapturedAt: request.snapshot.capturedAt, startsAt: request.startsAt, endsAt: request.endsAt,
      room: { id: request.roomId, siteId: request.snapshot.pricing.room.siteId, name: request.snapshot.pricing.room.name },
      title: request.snapshot.details.title, participantCount: request.snapshot.pricing.catering.participantCount,
      dietaryRequirements: request.snapshot.details.dietaryRequirements,
      specialRequirements: request.snapshot.details.specialRequirements,
      positions, conferencePrice, providerCost: null };
  });
  return frozenCopy(orders);
}

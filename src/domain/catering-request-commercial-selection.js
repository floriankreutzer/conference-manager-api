import { normalizeRequest } from './request.js';
import { normalizeTenantCatalogue } from './tenant-catalogue.js';
import { normalizeCateringCatalogueAssignments } from './catering-catalogue-assignments.js';
import { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';

function invalid() { throw new TypeError('CATERING_REQUEST_COMMERCIAL_SELECTION_INVALID'); }
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

// Pure commercial selection only, including before confirmation. Inputs must be
// independently loaded by an authorized transaction. This allocates no order,
// position or query identity and grants no publication/availability authority.
export function createCateringRequestCommercialSelection({ request: requestValue,
  ownership,canonicalCatalogue,connections }={}) {
  const request=normalizeRequest(requestValue); if (request.snapshot === null) invalid();
  const canonical = normalizeTenantCatalogue(canonicalCatalogue);
  const catalogueRevision = request.snapshot.configurationRevisions.catalogue;
  const normalizedOwnership = normalizeCateringCatalogueAssignments(ownership, {
    tenantId: request.tenantId, catalogueRevision, catalogue: canonical, connections,
  });
  const owners = new Map(normalizedOwnership.assignments.map((entry) => [`${entry.kind}:${entry.entryId}`, entry.integrationId]));
  const itemById = new Map(canonical.cateringItems.map((entry) => [entry.id, entry]));
  const groups = new Map();
  function addPosition(kind, entry, quantity, lineTotalMinor, packageDetails = null) {
    const integrationId = owners.get(`${kind}:${entry.id}`);
    if (!integrationId) invalid();
    if (!groups.has(integrationId)) groups.set(integrationId, []);
    groups.get(integrationId).push({ kind, entryId: entry.id, name: entry.name,
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
  const allPositions = [...groups.values()].flat();
  const total = allPositions.reduce((sum, position) => sum + position.conferenceLineTotalMinor, 0);
  if (total !== expectedTotal || allPositions.length > CATERING_MAX_ORDER_POSITIONS) invalid();
  return frozenCopy([...groups].sort(([left],[right])=>left<right ? -1 : left>right ? 1 : 0)
    .map(([integrationId,positions])=>({integrationId,positions})));
}

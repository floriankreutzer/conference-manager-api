import { MoneyValidationError, isSupportedCurrencyCode, normalizeMoney } from './money.js';
import {
  TenantBookingPolicyInputError,
  normalizeTenantBookingPolicySnapshot,
} from './tenant-booking-policies.js';
import { createTenantCostAllocationSnapshot } from './tenant-cost-allocation.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const MAX_SERVICES = 200;
const MAX_EQUIPMENT = 200;
const MAX_ITEM_QUANTITIES = 100;
const MAX_PACKAGE_ITEMS = 300;
const MAX_ALLOCATIONS = 100;
const MAX_ITEM_QUANTITY = 1_000;
const MAX_REQUIREMENTS_LENGTH = 2_000;
const MAX_TOTAL_MINOR = Number.MAX_SAFE_INTEGER;
const COST_CENTER_CODE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const CONFIGURATION_REVISION_KEYS = Object.freeze([
  'organization',
  'locations',
  'catalogue',
  'bookingPolicies',
  'costAllocation',
]);

export const REQUEST_COMPOSITION_SCHEMA_VERSION = 2;
export const REQUEST_COMPOSITION_V3_SCHEMA_VERSION = 3;
export const SUPPORTED_REQUEST_COMPOSITION_SCHEMA_VERSIONS = Object.freeze([
  REQUEST_COMPOSITION_SCHEMA_VERSION,
  REQUEST_COMPOSITION_V3_SCHEMA_VERSION,
]);
export const REQUEST_MAX_PARTICIPANTS = 500;

export function isSupportedRequestCompositionSchemaVersion(value) {
  return SUPPORTED_REQUEST_COMPOSITION_SCHEMA_VERSIONS.includes(value);
}

export class RequestCompositionInputError extends Error {
  constructor(code = 'REQUEST_COMPOSITION_INVALID') {
    super(code);
    this.name = 'RequestCompositionInputError';
    this.code = code;
  }
}

export class RequestCompositionUnavailableError extends Error {
  constructor(code = 'REQUEST_CONFIGURATION_UNAVAILABLE') {
    super(code);
    this.name = 'RequestCompositionUnavailableError';
    this.code = code;
  }
}

function invalid(code = 'REQUEST_COMPOSITION_INVALID') {
  throw new RequestCompositionInputError(code);
}

function unavailable() {
  throw new RequestCompositionUnavailableError();
}

function exactObject(value, keys, code = 'REQUEST_COMPOSITION_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
  return value;
}

function identifier(value, code = 'REQUEST_REFERENCE_INVALID') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid(code);
  return value;
}

function identifierList(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) invalid(code);
  const result = value.map((entry) => identifier(entry, code));
  if (new Set(result).size !== result.length) invalid(code);
  return Object.freeze([...result].sort());
}

function text(value, { minimum = 1, maximum, nullable = false, code }) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || UNSAFE_TEXT.test(value)) invalid(code);
  const normalized = value.trim().normalize('NFC');
  if (nullable && normalized.length === 0) return null;
  if (normalized.length < minimum || normalized.length > maximum) invalid(code);
  return normalized;
}

function utcInstant(value, code) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) invalid(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function positiveVersion(value, code = 'REQUEST_VERSION_INVALID') {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid(code);
  return value;
}

function minorAmount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOTAL_MINOR) invalid(code);
  return value;
}

function snapshotMoney(value, code) {
  try {
    return normalizeMoney(value);
  } catch (error) {
    if (error instanceof MoneyValidationError) invalid(code);
    throw error;
  }
}

function sameIdentifiers(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function metadataText(value, { maximum, nullable = false, code }) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') invalid(code);
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length < 1
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) invalid(code);
  return normalized;
}

function participantCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > REQUEST_MAX_PARTICIPANTS) {
    invalid('REQUEST_PARTICIPANTS_INVALID');
  }
  return value;
}

function packageSelection(value) {
  if (value === null) return null;
  const selection = exactObject(
    value,
    ['packageId', 'variantId'],
    'REQUEST_CATERING_PACKAGE_INVALID',
  );
  return Object.freeze({
    packageId: identifier(selection.packageId, 'REQUEST_CATERING_PACKAGE_INVALID'),
    variantId: identifier(selection.variantId, 'REQUEST_CATERING_VARIANT_INVALID'),
  });
}

function itemQuantity(value) {
  const entry = exactObject(
    value,
    ['itemId', 'quantity'],
    'REQUEST_CATERING_ITEM_INVALID',
  );
  if (
    !Number.isSafeInteger(entry.quantity)
    || entry.quantity < 1
    || entry.quantity > MAX_ITEM_QUANTITY
  ) invalid('REQUEST_CATERING_ITEM_QUANTITY_INVALID');
  return Object.freeze({
    itemId: identifier(entry.itemId, 'REQUEST_CATERING_ITEM_INVALID'),
    quantity: entry.quantity,
  });
}

function catering(value, totalParticipants) {
  const normalized = exactObject(
    value,
    ['participantCount', 'packageSelection', 'itemQuantities'],
    'REQUEST_CATERING_INVALID',
  );
  const participantCountValue = participantCount(normalized.participantCount);
  if (participantCountValue > totalParticipants) invalid('REQUEST_CATERING_PARTICIPANTS_INVALID');
  if (
    !Array.isArray(normalized.itemQuantities)
    || normalized.itemQuantities.length > MAX_ITEM_QUANTITIES
  ) invalid('REQUEST_CATERING_ITEMS_INVALID');
  const itemQuantities = normalized.itemQuantities.map(itemQuantity);
  if (new Set(itemQuantities.map((entry) => entry.itemId)).size !== itemQuantities.length) {
    invalid('REQUEST_CATERING_ITEM_DUPLICATE');
  }
  const selectedPackage = packageSelection(normalized.packageSelection);
  if (selectedPackage !== null && participantCountValue < 1) {
    invalid('REQUEST_CATERING_PARTICIPANTS_INVALID');
  }
  return Object.freeze({
    participantCount: participantCountValue,
    packageSelection: selectedPackage,
    itemQuantities: Object.freeze([...itemQuantities].sort((left, right) => (
      left.itemId.localeCompare(right.itemId)
    ))),
  });
}

function allocation(value) {
  const entry = exactObject(
    value,
    ['costCenterId', 'percentageBasisPoints'],
    'REQUEST_COST_ALLOCATION_INVALID',
  );
  if (
    !Number.isSafeInteger(entry.percentageBasisPoints)
    || entry.percentageBasisPoints < 1
    || entry.percentageBasisPoints > 10_000
  ) invalid('REQUEST_COST_ALLOCATION_INVALID');
  return Object.freeze({
    costCenterId: identifier(entry.costCenterId, 'REQUEST_COST_CENTER_INVALID'),
    percentageBasisPoints: entry.percentageBasisPoints,
  });
}

export function normalizeRequestV2Draft(value) {
  const draft = exactObject(value, [
    'title',
    'roomId',
    'startsAt',
    'endsAt',
    'internalParticipants',
    'externalParticipants',
    'serviceIds',
    'catering',
    'dietaryRequirements',
    'specialRequirements',
    'allocations',
    'configurationRevisions',
  ]);
  const startsAt = utcInstant(draft.startsAt, 'REQUEST_SCHEDULE_INVALID');
  const endsAt = utcInstant(draft.endsAt, 'REQUEST_SCHEDULE_INVALID');
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1_000) invalid('REQUEST_SCHEDULE_INVALID');
  const internalParticipants = participantCount(draft.internalParticipants);
  const externalParticipants = participantCount(draft.externalParticipants);
  const totalParticipants = internalParticipants + externalParticipants;
  if (totalParticipants < 1 || totalParticipants > REQUEST_MAX_PARTICIPANTS) {
    invalid('REQUEST_PARTICIPANTS_INVALID');
  }
  if (!Array.isArray(draft.allocations) || draft.allocations.length > MAX_ALLOCATIONS) {
    invalid('REQUEST_COST_ALLOCATIONS_INVALID');
  }
  const allocations = draft.allocations.map(allocation);
  if (new Set(allocations.map((entry) => entry.costCenterId)).size !== allocations.length) {
    invalid('REQUEST_COST_CENTER_DUPLICATE');
  }
  return Object.freeze({
    title: text(draft.title, { maximum: 160, code: 'REQUEST_TITLE_INVALID' }),
    roomId: identifier(draft.roomId, 'REQUEST_ROOM_INVALID'),
    startsAt,
    endsAt,
    internalParticipants,
    externalParticipants,
    serviceIds: identifierList(
      draft.serviceIds,
      MAX_SERVICES,
      'REQUEST_SERVICES_INVALID',
    ),
    catering: catering(draft.catering, totalParticipants),
    dietaryRequirements: text(draft.dietaryRequirements, {
      maximum: MAX_REQUIREMENTS_LENGTH,
      nullable: true,
      code: 'REQUEST_DIETARY_REQUIREMENTS_INVALID',
    }),
    specialRequirements: text(draft.specialRequirements, {
      maximum: MAX_REQUIREMENTS_LENGTH,
      nullable: true,
      code: 'REQUEST_SPECIAL_REQUIREMENTS_INVALID',
    }),
    allocations: Object.freeze([...allocations].sort((left, right) => (
      left.costCenterId.localeCompare(right.costCenterId)
    ))),
    configurationRevisions: configurationRevisions(draft.configurationRevisions),
  });
}

function requestV2DraftFromV3(draft) {
  return {
    title: draft.title,
    roomId: draft.roomId,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    internalParticipants: draft.internalParticipants,
    externalParticipants: draft.externalParticipants,
    serviceIds: draft.serviceIds,
    catering: draft.catering,
    dietaryRequirements: draft.dietaryRequirements,
    specialRequirements: draft.specialRequirements,
    allocations: draft.allocations,
    configurationRevisions: draft.configurationRevisions,
  };
}

export function normalizeRequestV3Draft(value) {
  const draft = exactObject(value, [
    'title',
    'roomId',
    'startsAt',
    'endsAt',
    'internalParticipants',
    'externalParticipants',
    'serviceIds',
    'equipmentIds',
    'catering',
    'dietaryRequirements',
    'specialRequirements',
    'allocations',
    'configurationRevisions',
  ]);
  const normalizedV2 = normalizeRequestV2Draft(requestV2DraftFromV3(draft));
  return Object.freeze({
    title: normalizedV2.title,
    roomId: normalizedV2.roomId,
    startsAt: normalizedV2.startsAt,
    endsAt: normalizedV2.endsAt,
    internalParticipants: normalizedV2.internalParticipants,
    externalParticipants: normalizedV2.externalParticipants,
    serviceIds: normalizedV2.serviceIds,
    equipmentIds: identifierList(
      draft.equipmentIds,
      MAX_EQUIPMENT,
      'REQUEST_EQUIPMENT_INVALID',
    ),
    catering: normalizedV2.catering,
    dietaryRequirements: normalizedV2.dietaryRequirements,
    specialRequirements: normalizedV2.specialRequirements,
    allocations: normalizedV2.allocations,
    configurationRevisions: normalizedV2.configurationRevisions,
  });
}

export function normalizeRequestCompositionDraft(value, schemaVersion) {
  switch (schemaVersion) {
    case REQUEST_COMPOSITION_SCHEMA_VERSION:
      return normalizeRequestV2Draft(value);
    case REQUEST_COMPOSITION_V3_SCHEMA_VERSION:
      return normalizeRequestV3Draft(value);
    default:
      invalid('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
  }
}

function immutableCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, immutableCopy(entry)]),
    ));
  }
  return value;
}

function requireSnapshotEntry(value, code) {
  const entry = exactObject(value, ['id', 'name', 'description', 'price'], code);
  return Object.freeze({
    id: identifier(entry.id, code),
    name: text(entry.name, { maximum: 160, code }),
    description: text(entry.description, { maximum: 1_000, nullable: true, code }),
    price: snapshotMoney(entry.price, code),
  });
}

function lineTotal(amountMinor, multiplier, code) {
  if (!Number.isSafeInteger(multiplier) || multiplier < 0) invalid(code);
  const total = BigInt(amountMinor) * BigInt(multiplier);
  if (total > BigInt(MAX_TOTAL_MINOR)) invalid('REQUEST_TOTAL_EXCESSIVE');
  return Number(total);
}

function safeSum(values) {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(MAX_TOTAL_MINOR)) invalid('REQUEST_TOTAL_EXCESSIVE');
  return Number(total);
}

function resolveCurrency(lines, defaultCurrency) {
  if (!isSupportedCurrencyCode(defaultCurrency)) invalid('REQUEST_DEFAULT_CURRENCY_INVALID');
  const currencies = new Set(lines.map((line) => line.currency));
  if (currencies.size > 1) invalid('REQUEST_MIXED_CURRENCY');
  return currencies.size === 0 ? defaultCurrency : [...currencies][0];
}

function snapshotEntries(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) invalid(code);
  const entries = value.map((entry) => requireSnapshotEntry(entry, code));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) invalid(code);
  return Object.freeze(entries);
}

function normalizeCatalogueSnapshot(value, draft, room) {
  const snapshot = exactObject(value, [
    'schemaVersion',
    'catalogRevision',
    'capturedAt',
    'siteId',
    'roomId',
    'services',
    'equipment',
    'cateringItems',
    'catering',
  ], 'REQUEST_CATALOGUE_SNAPSHOT_INVALID');
  if (
    snapshot.schemaVersion !== 1
    || !Array.isArray(snapshot.equipment)
    || snapshot.equipment.length !== 0
    || !Array.isArray(snapshot.catering)
    || snapshot.catering.length > 1
  ) invalid('REQUEST_CATALOGUE_SNAPSHOT_INVALID');
  const normalized = Object.freeze({
    schemaVersion: 1,
    catalogRevision: positiveVersion(
      snapshot.catalogRevision,
      'REQUEST_CATALOGUE_SNAPSHOT_INVALID',
    ),
    capturedAt: utcInstant(snapshot.capturedAt, 'REQUEST_CATALOGUE_SNAPSHOT_INVALID'),
    siteId: identifier(snapshot.siteId, 'REQUEST_CATALOGUE_SNAPSHOT_INVALID'),
    roomId: identifier(snapshot.roomId, 'REQUEST_CATALOGUE_SNAPSHOT_INVALID'),
    services: snapshotEntries(
      snapshot.services,
      MAX_SERVICES,
      'REQUEST_SERVICE_SNAPSHOT_INVALID',
    ),
    equipment: Object.freeze([]),
    cateringItems: snapshotEntries(
      snapshot.cateringItems,
      MAX_ITEM_QUANTITIES,
      'REQUEST_CATERING_ITEM_SNAPSHOT_INVALID',
    ),
    catering: snapshot.catering,
  });
  if (
    normalized.siteId !== room.siteId
    || normalized.roomId !== room.id
    || normalized.roomId !== draft.roomId
  ) unavailable();
  const selectedServiceIds = [...normalized.services.map((entry) => entry.id)].sort();
  const selectedItemIds = [...normalized.cateringItems.map((entry) => entry.id)].sort();
  if (
    !sameIdentifiers(selectedServiceIds, draft.serviceIds)
    || !sameIdentifiers(
      selectedItemIds,
      draft.catering.itemQuantities.map((entry) => entry.itemId),
    )
  ) unavailable();
  return normalized;
}

export function priceRequestComposition({
  draft: draftValue,
  room,
  catalogueSnapshot,
  defaultCurrency,
}) {
  const draft = normalizeRequestV2Draft(draftValue);
  const roomEntry = exactObject(room, ['id', 'siteId', 'name', 'price'], 'REQUEST_ROOM_SNAPSHOT_INVALID');
  const normalizedRoom = Object.freeze({
    id: identifier(roomEntry.id, 'REQUEST_ROOM_SNAPSHOT_INVALID'),
    siteId: identifier(roomEntry.siteId, 'REQUEST_ROOM_SNAPSHOT_INVALID'),
    name: metadataText(roomEntry.name, {
      maximum: 160,
      code: 'REQUEST_ROOM_SNAPSHOT_INVALID',
    }),
    price: snapshotMoney(roomEntry.price, 'REQUEST_ROOM_SNAPSHOT_INVALID'),
  });
  if (normalizedRoom.id !== draft.roomId) unavailable();
  const normalizedCatalogue = normalizeCatalogueSnapshot(
    catalogueSnapshot,
    draft,
    normalizedRoom,
  );
  const roomPrice = normalizedRoom.price;
  const services = normalizedCatalogue.services;
  const serviceById = new Map(services.map((entry) => [entry.id, entry]));
  const directItems = normalizedCatalogue.cateringItems;
  const directItemById = new Map(directItems.map((entry) => [entry.id, entry]));
  const packageSnapshots = normalizedCatalogue.catering;
  let selectedPackage = null;
  let includedItemIds = new Set();
  if (draft.catering.packageSelection !== null) {
    if (packageSnapshots.length !== 1) unavailable();
    const value = exactObject(
      packageSnapshots[0],
      ['package', 'variant', 'items'],
      'REQUEST_CATERING_PACKAGE_SNAPSHOT_INVALID',
    );
    const packageEntry = requireSnapshotEntry(
      value.package,
      'REQUEST_CATERING_PACKAGE_SNAPSHOT_INVALID',
    );
    const variantEntry = requireSnapshotEntry(
      value.variant,
      'REQUEST_CATERING_VARIANT_SNAPSHOT_INVALID',
    );
    if (
      packageEntry.id !== draft.catering.packageSelection.packageId
      || variantEntry.id !== draft.catering.packageSelection.variantId
    ) unavailable();
    const includedItems = snapshotEntries(
      value.items,
      MAX_PACKAGE_ITEMS,
      'REQUEST_CATERING_ITEM_SNAPSHOT_INVALID',
    );
    includedItemIds = new Set(includedItems.map((entry) => entry.id));
    selectedPackage = Object.freeze({
      package: packageEntry,
      variant: variantEntry,
      includedItems: Object.freeze(includedItems),
      participantCount: draft.catering.participantCount,
      lineTotalMinor: lineTotal(
        variantEntry.price.amountMinor,
        draft.catering.participantCount,
        'REQUEST_CATERING_PARTICIPANTS_INVALID',
      ),
    });
  } else if (packageSnapshots.length !== 0) {
    unavailable();
  }

  const serviceLines = draft.serviceIds.map((id) => {
    const service = serviceById.get(id);
    return Object.freeze({ service, lineTotalMinor: service.price.amountMinor });
  });
  const itemLines = draft.catering.itemQuantities.map(({ itemId, quantity }) => {
    const item = directItemById.get(itemId);
    const includedByPackage = includedItemIds.has(itemId);
    return Object.freeze({
      item,
      quantity,
      includedByPackage,
      lineTotalMinor: includedByPackage ? 0 : lineTotal(item.price.amountMinor, quantity),
    });
  });
  const currency = resolveCurrency([
    roomPrice,
    ...serviceLines.map((line) => line.service.price),
    ...(selectedPackage ? [selectedPackage.variant.price] : []),
    ...itemLines
      .filter((line) => !line.includedByPackage)
      .map((line) => line.item.price),
  ], defaultCurrency);
  const roomMinor = roomPrice.amountMinor;
  const servicesMinor = safeSum(serviceLines.map((line) => line.lineTotalMinor));
  const cateringPackageMinor = selectedPackage?.lineTotalMinor ?? 0;
  const cateringItemsMinor = safeSum(itemLines.map((line) => line.lineTotalMinor));
  const totalMinor = safeSum([
    roomMinor,
    servicesMinor,
    cateringPackageMinor,
    cateringItemsMinor,
  ]);
  return immutableCopy({
    currency: totalMinor === 0 ? defaultCurrency : currency,
    totalMinor,
    breakdown: {
      roomMinor,
      servicesMinor,
      cateringPackageMinor,
      cateringItemsMinor,
    },
    room: {
      id: normalizedRoom.id,
      siteId: normalizedRoom.siteId,
      name: normalizedRoom.name,
      price: roomPrice,
    },
    services: serviceLines,
    catering: {
      participantCount: draft.catering.participantCount,
      packageSelection: selectedPackage,
      items: itemLines,
    },
  });
}

function catalogueWithoutEquipment(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    catalogRevision: snapshot.catalogRevision,
    capturedAt: snapshot.capturedAt,
    siteId: snapshot.siteId,
    roomId: snapshot.roomId,
    services: snapshot.services,
    equipment: [],
    cateringItems: snapshot.cateringItems,
    catering: snapshot.catering,
  };
}

export function priceRequestV3Composition({
  draft: draftValue,
  room,
  catalogueSnapshot,
  defaultCurrency,
}) {
  const draft = normalizeRequestV3Draft(draftValue);
  const snapshot = exactObject(catalogueSnapshot, [
    'schemaVersion',
    'catalogRevision',
    'capturedAt',
    'siteId',
    'roomId',
    'services',
    'equipment',
    'cateringItems',
    'catering',
  ], 'REQUEST_CATALOGUE_SNAPSHOT_INVALID');
  const basePricing = priceRequestComposition({
    draft: requestV2DraftFromV3(draft),
    room,
    catalogueSnapshot: catalogueWithoutEquipment(snapshot),
    defaultCurrency,
  });
  const equipment = snapshotEntries(
    snapshot.equipment,
    MAX_EQUIPMENT,
    'REQUEST_EQUIPMENT_SNAPSHOT_INVALID',
  );
  const equipmentIds = [...equipment.map((entry) => entry.id)].sort();
  if (!sameIdentifiers(equipmentIds, draft.equipmentIds)) unavailable();
  const equipmentById = new Map(equipment.map((entry) => [entry.id, entry]));
  const equipmentLines = draft.equipmentIds.map((id) => {
    const equipmentEntry = equipmentById.get(id);
    return Object.freeze({
      equipment: equipmentEntry,
      lineTotalMinor: equipmentEntry.price.amountMinor,
    });
  });
  const equipmentMinor = safeSum(equipmentLines.map((line) => line.lineTotalMinor));
  const totalMinor = safeSum([basePricing.totalMinor, equipmentMinor]);
  const currency = resolveCurrency([
    basePricing.room.price,
    ...basePricing.services.map((line) => line.service.price),
    ...equipmentLines.map((line) => line.equipment.price),
    ...(basePricing.catering.packageSelection
      ? [basePricing.catering.packageSelection.variant.price]
      : []),
    ...basePricing.catering.items
      .filter((line) => !line.includedByPackage)
      .map((line) => line.item.price),
  ], defaultCurrency);
  return immutableCopy({
    currency: totalMinor === 0 ? defaultCurrency : currency,
    totalMinor,
    breakdown: {
      roomMinor: basePricing.breakdown.roomMinor,
      servicesMinor: basePricing.breakdown.servicesMinor,
      equipmentMinor,
      cateringPackageMinor: basePricing.breakdown.cateringPackageMinor,
      cateringItemsMinor: basePricing.breakdown.cateringItemsMinor,
    },
    room: basePricing.room,
    services: basePricing.services,
    equipment: equipmentLines,
    catering: basePricing.catering,
  });
}

export function priceRequestCompositionForSchemaVersion({ schemaVersion, ...values }) {
  switch (schemaVersion) {
    case REQUEST_COMPOSITION_SCHEMA_VERSION:
      return priceRequestComposition(values);
    case REQUEST_COMPOSITION_V3_SCHEMA_VERSION:
      return priceRequestV3Composition(values);
    default:
      invalid('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
  }
}

function configurationRevisions(value) {
  const revisions = exactObject(
    value,
    CONFIGURATION_REVISION_KEYS,
    'REQUEST_CONFIGURATION_REVISIONS_INVALID',
  );
  return Object.freeze({
    organization: positiveVersion(
      revisions.organization,
      'REQUEST_CONFIGURATION_REVISIONS_INVALID',
    ),
    locations: positiveVersion(
      revisions.locations,
      'REQUEST_CONFIGURATION_REVISIONS_INVALID',
    ),
    catalogue: positiveVersion(
      revisions.catalogue,
      'REQUEST_CONFIGURATION_REVISIONS_INVALID',
    ),
    bookingPolicies: positiveVersion(
      revisions.bookingPolicies,
      'REQUEST_CONFIGURATION_REVISIONS_INVALID',
    ),
    costAllocation: positiveVersion(
      revisions.costAllocation,
      'REQUEST_CONFIGURATION_REVISIONS_INVALID',
    ),
  });
}

function normalizeAllocationEntrySnapshot(value) {
  const entry = exactObject(value, [
    'costCenterId',
    'code',
    'name',
    'group',
    'percentageBasisPoints',
    'allocatedMinor',
  ], 'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  if (
    typeof entry.code !== 'string'
    || !COST_CENTER_CODE.test(entry.code)
    || !Number.isSafeInteger(entry.percentageBasisPoints)
    || entry.percentageBasisPoints < 1
    || entry.percentageBasisPoints > 10_000
  ) invalid('REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  return Object.freeze({
    costCenterId: identifier(
      entry.costCenterId,
      'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
    ),
    code: entry.code,
    name: metadataText(entry.name, {
      maximum: 160,
      code: 'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
    }),
    group: metadataText(entry.group, {
      maximum: 160,
      nullable: true,
      code: 'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
    }),
    percentageBasisPoints: entry.percentageBasisPoints,
    allocatedMinor: minorAmount(
      entry.allocatedMinor,
      'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
    ),
  });
}

function normalizeAllocationSnapshot(value) {
  const snapshot = exactObject(value, [
    'schemaVersion',
    'configurationRevision',
    'snapshottedAt',
    'model',
    'totalBasisPoints',
    'totalMinor',
    'allocatedMinor',
    'unallocatedMinor',
    'currency',
    'entries',
  ], 'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  if (
    snapshot.schemaVersion !== 1
    || snapshot.model !== 'percentage_basis_points'
    || !isSupportedCurrencyCode(snapshot.currency)
    || !Array.isArray(snapshot.entries)
    || snapshot.entries.length > MAX_ALLOCATIONS
  ) invalid('REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  const entries = snapshot.entries.map(normalizeAllocationEntrySnapshot);
  if (
    new Set(entries.map((entry) => entry.costCenterId)).size !== entries.length
    || new Set(entries.map((entry) => entry.code)).size !== entries.length
  ) invalid('REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  const totalBasisPoints = minorAmount(
    snapshot.totalBasisPoints,
    'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
  );
  const totalMinor = minorAmount(
    snapshot.totalMinor,
    'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
  );
  const allocatedMinor = minorAmount(
    snapshot.allocatedMinor,
    'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
  );
  const unallocatedMinor = minorAmount(
    snapshot.unallocatedMinor,
    'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
  );
  if (
    totalBasisPoints !== entries.reduce(
      (sum, entry) => sum + entry.percentageBasisPoints,
      0,
    )
    || ![0, 10_000].includes(totalBasisPoints)
    || allocatedMinor !== safeSum(entries.map((entry) => entry.allocatedMinor))
    || safeSum([allocatedMinor, unallocatedMinor]) !== totalMinor
  ) invalid('REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  const recalculated = createTenantCostAllocationSnapshot({
    allocationRequired: entries.length > 0,
    costCenters: entries.map((entry) => ({
      id: entry.costCenterId,
      code: entry.code,
      name: entry.name,
      group: entry.group,
      active: true,
    })),
  }, {
    entries: entries.map((entry) => ({
      costCenterId: entry.costCenterId,
      percentageBasisPoints: entry.percentageBasisPoints,
    })),
    totalMinor,
    currency: snapshot.currency,
  });
  if (entries.some((entry, index) => (
    entry.allocatedMinor !== recalculated.entries[index].allocatedMinor
  ))) invalid('REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID');
  return immutableCopy({
    schemaVersion: 1,
    configurationRevision: positiveVersion(
      snapshot.configurationRevision,
      'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
    ),
    snapshottedAt: utcInstant(
      snapshot.snapshottedAt,
      'REQUEST_COST_ALLOCATION_SNAPSHOT_INVALID',
    ),
    model: snapshot.model,
    totalBasisPoints,
    totalMinor,
    allocatedMinor,
    unallocatedMinor,
    currency: snapshot.currency,
    entries,
  });
}

function normalizeDetailsSnapshot(value) {
  const details = exactObject(value, [
    'title',
    'specialRequirements',
    'dietaryRequirements',
    'serviceIds',
    'catering',
  ], 'REQUEST_DETAILS_SNAPSHOT_INVALID');
  return Object.freeze({
    title: text(details.title, {
      maximum: 160,
      code: 'REQUEST_DETAILS_SNAPSHOT_INVALID',
    }),
    specialRequirements: text(details.specialRequirements, {
      maximum: MAX_REQUIREMENTS_LENGTH,
      nullable: true,
      code: 'REQUEST_DETAILS_SNAPSHOT_INVALID',
    }),
    dietaryRequirements: text(details.dietaryRequirements, {
      maximum: MAX_REQUIREMENTS_LENGTH,
      nullable: true,
      code: 'REQUEST_DETAILS_SNAPSHOT_INVALID',
    }),
    serviceIds: identifierList(
      details.serviceIds,
      MAX_SERVICES,
      'REQUEST_DETAILS_SNAPSHOT_INVALID',
    ),
    catering: catering(details.catering, REQUEST_MAX_PARTICIPANTS),
  });
}

function normalizeDetailsV3Snapshot(value) {
  const details = exactObject(value, [
    'title',
    'specialRequirements',
    'dietaryRequirements',
    'serviceIds',
    'equipmentIds',
    'catering',
  ], 'REQUEST_DETAILS_SNAPSHOT_INVALID');
  const normalizedV2 = normalizeDetailsSnapshot({
    title: details.title,
    specialRequirements: details.specialRequirements,
    dietaryRequirements: details.dietaryRequirements,
    serviceIds: details.serviceIds,
    catering: details.catering,
  });
  return Object.freeze({
    title: normalizedV2.title,
    specialRequirements: normalizedV2.specialRequirements,
    dietaryRequirements: normalizedV2.dietaryRequirements,
    serviceIds: normalizedV2.serviceIds,
    equipmentIds: identifierList(
      details.equipmentIds,
      MAX_EQUIPMENT,
      'REQUEST_DETAILS_SNAPSHOT_INVALID',
    ),
    catering: normalizedV2.catering,
  });
}

function normalizePricingRoom(value) {
  const room = exactObject(
    value,
    ['id', 'siteId', 'name', 'price'],
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  return Object.freeze({
    id: identifier(room.id, 'REQUEST_PRICING_SNAPSHOT_INVALID'),
    siteId: identifier(room.siteId, 'REQUEST_PRICING_SNAPSHOT_INVALID'),
    name: metadataText(room.name, {
      maximum: 160,
      code: 'REQUEST_PRICING_SNAPSHOT_INVALID',
    }),
    price: snapshotMoney(room.price, 'REQUEST_PRICING_SNAPSHOT_INVALID'),
  });
}

function normalizeServicePricingLine(value) {
  const line = exactObject(
    value,
    ['service', 'lineTotalMinor'],
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const service = requireSnapshotEntry(line.service, 'REQUEST_PRICING_SNAPSHOT_INVALID');
  const lineTotalMinor = minorAmount(
    line.lineTotalMinor,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  if (lineTotalMinor !== service.price.amountMinor) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  return Object.freeze({ service, lineTotalMinor });
}

function normalizeEquipmentPricingLine(value) {
  const line = exactObject(
    value,
    ['equipment', 'lineTotalMinor'],
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const equipment = requireSnapshotEntry(
    line.equipment,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const lineTotalMinor = minorAmount(
    line.lineTotalMinor,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  if (lineTotalMinor !== equipment.price.amountMinor) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  return Object.freeze({ equipment, lineTotalMinor });
}

function normalizePackagePricing(value) {
  if (value === null) return null;
  const selection = exactObject(value, [
    'package',
    'variant',
    'includedItems',
    'participantCount',
    'lineTotalMinor',
  ], 'REQUEST_PRICING_SNAPSHOT_INVALID');
  const packageEntry = requireSnapshotEntry(
    selection.package,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const variant = requireSnapshotEntry(
    selection.variant,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const includedItems = snapshotEntries(
    selection.includedItems,
    MAX_PACKAGE_ITEMS,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const normalizedParticipantCount = participantCount(selection.participantCount);
  if (normalizedParticipantCount < 1) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  const lineTotalMinor = minorAmount(
    selection.lineTotalMinor,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  if (
    lineTotalMinor !== lineTotal(
      variant.price.amountMinor,
      normalizedParticipantCount,
      'REQUEST_PRICING_SNAPSHOT_INVALID',
    )
  ) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  return Object.freeze({
    package: packageEntry,
    variant,
    includedItems,
    participantCount: normalizedParticipantCount,
    lineTotalMinor,
  });
}

function normalizeItemPricingLine(value, includedItemIds) {
  const line = exactObject(value, [
    'item',
    'quantity',
    'includedByPackage',
    'lineTotalMinor',
  ], 'REQUEST_PRICING_SNAPSHOT_INVALID');
  const item = requireSnapshotEntry(line.item, 'REQUEST_PRICING_SNAPSHOT_INVALID');
  if (
    !Number.isSafeInteger(line.quantity)
    || line.quantity < 1
    || line.quantity > MAX_ITEM_QUANTITY
    || typeof line.includedByPackage !== 'boolean'
  ) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  const includedByPackage = includedItemIds.has(item.id);
  const lineTotalMinor = minorAmount(
    line.lineTotalMinor,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  if (
    line.includedByPackage !== includedByPackage
    || lineTotalMinor !== (
      includedByPackage ? 0 : lineTotal(item.price.amountMinor, line.quantity)
    )
  ) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  return Object.freeze({
    item,
    quantity: line.quantity,
    includedByPackage,
    lineTotalMinor,
  });
}

function sameSnapshotEntry(left, right) {
  return left.id === right.id
    && left.name === right.name
    && left.description === right.description
    && left.price.amountMinor === right.price.amountMinor
    && left.price.currency === right.price.currency;
}

function normalizePricingSnapshot(value) {
  const pricing = exactObject(value, [
    'currency',
    'totalMinor',
    'breakdown',
    'room',
    'services',
    'catering',
  ], 'REQUEST_PRICING_SNAPSHOT_INVALID');
  if (
    !isSupportedCurrencyCode(pricing.currency)
    || !Array.isArray(pricing.services)
    || pricing.services.length > MAX_SERVICES
  ) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  const room = normalizePricingRoom(pricing.room);
  const services = pricing.services.map(normalizeServicePricingLine);
  if (new Set(services.map((line) => line.service.id)).size !== services.length) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  services.sort((left, right) => left.service.id.localeCompare(right.service.id));

  const cateringSnapshot = exactObject(
    pricing.catering,
    ['participantCount', 'packageSelection', 'items'],
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  const cateringParticipantCount = participantCount(cateringSnapshot.participantCount);
  const selectedPackage = normalizePackagePricing(cateringSnapshot.packageSelection);
  if (
    (selectedPackage !== null && selectedPackage.participantCount !== cateringParticipantCount)
    || !Array.isArray(cateringSnapshot.items)
    || cateringSnapshot.items.length > MAX_ITEM_QUANTITIES
  ) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  const includedItemIds = new Set(
    selectedPackage?.includedItems.map((entry) => entry.id) ?? [],
  );
  const items = cateringSnapshot.items.map((line) => (
    normalizeItemPricingLine(line, includedItemIds)
  ));
  if (new Set(items.map((line) => line.item.id)).size !== items.length) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  items.sort((left, right) => left.item.id.localeCompare(right.item.id));
  const includedItemsById = new Map(
    selectedPackage?.includedItems.map((entry) => [entry.id, entry]) ?? [],
  );
  if (items.some((line) => (
    line.includedByPackage && !sameSnapshotEntry(line.item, includedItemsById.get(line.item.id))
  ))) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');

  const breakdown = exactObject(pricing.breakdown, [
    'roomMinor',
    'servicesMinor',
    'cateringPackageMinor',
    'cateringItemsMinor',
  ], 'REQUEST_PRICING_SNAPSHOT_INVALID');
  const normalizedBreakdown = Object.freeze({
    roomMinor: minorAmount(
      breakdown.roomMinor,
      'REQUEST_PRICING_SNAPSHOT_INVALID',
    ),
    servicesMinor: minorAmount(
      breakdown.servicesMinor,
      'REQUEST_PRICING_SNAPSHOT_INVALID',
    ),
    cateringPackageMinor: minorAmount(
      breakdown.cateringPackageMinor,
      'REQUEST_PRICING_SNAPSHOT_INVALID',
    ),
    cateringItemsMinor: minorAmount(
      breakdown.cateringItemsMinor,
      'REQUEST_PRICING_SNAPSHOT_INVALID',
    ),
  });
  const totalMinor = minorAmount(pricing.totalMinor, 'REQUEST_PRICING_SNAPSHOT_INVALID');
  if (
    normalizedBreakdown.roomMinor !== room.price.amountMinor
    || normalizedBreakdown.servicesMinor !== safeSum(
      services.map((line) => line.lineTotalMinor),
    )
    || normalizedBreakdown.cateringPackageMinor !== (selectedPackage?.lineTotalMinor ?? 0)
    || normalizedBreakdown.cateringItemsMinor !== safeSum(
      items.map((line) => line.lineTotalMinor),
    )
    || totalMinor !== safeSum(Object.values(normalizedBreakdown))
  ) invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  const resolvedCurrency = resolveCurrency([
    room.price,
    ...services.map((line) => line.service.price),
    ...(selectedPackage ? [selectedPackage.variant.price] : []),
    ...items
      .filter((line) => !line.includedByPackage)
      .map((line) => line.item.price),
  ], pricing.currency);
  if (totalMinor > 0 && pricing.currency !== resolvedCurrency) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  return immutableCopy({
    currency: pricing.currency,
    totalMinor,
    breakdown: normalizedBreakdown,
    room,
    services,
    catering: {
      participantCount: cateringParticipantCount,
      packageSelection: selectedPackage,
      items,
    },
  });
}

function normalizePricingV3Snapshot(value) {
  const pricing = exactObject(value, [
    'currency',
    'totalMinor',
    'breakdown',
    'room',
    'services',
    'equipment',
    'catering',
  ], 'REQUEST_PRICING_SNAPSHOT_INVALID');
  if (!Array.isArray(pricing.equipment) || pricing.equipment.length > MAX_EQUIPMENT) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  const equipment = pricing.equipment.map(normalizeEquipmentPricingLine);
  if (new Set(equipment.map((line) => line.equipment.id)).size !== equipment.length) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  equipment.sort((left, right) => {
    if (left.equipment.id < right.equipment.id) return -1;
    if (left.equipment.id > right.equipment.id) return 1;
    return 0;
  });
  const breakdown = exactObject(pricing.breakdown, [
    'roomMinor',
    'servicesMinor',
    'equipmentMinor',
    'cateringPackageMinor',
    'cateringItemsMinor',
  ], 'REQUEST_PRICING_SNAPSHOT_INVALID');
  const normalizedEquipmentMinor = minorAmount(
    breakdown.equipmentMinor,
    'REQUEST_PRICING_SNAPSHOT_INVALID',
  );
  if (normalizedEquipmentMinor !== safeSum(equipment.map((line) => line.lineTotalMinor))) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  const baseBreakdown = {
    roomMinor: breakdown.roomMinor,
    servicesMinor: breakdown.servicesMinor,
    cateringPackageMinor: breakdown.cateringPackageMinor,
    cateringItemsMinor: breakdown.cateringItemsMinor,
  };
  const baseTotalMinor = safeSum(Object.values(baseBreakdown).map((entry) => (
    minorAmount(entry, 'REQUEST_PRICING_SNAPSHOT_INVALID')
  )));
  const basePricing = normalizePricingSnapshot({
    currency: pricing.currency,
    totalMinor: baseTotalMinor,
    breakdown: baseBreakdown,
    room: pricing.room,
    services: pricing.services,
    catering: pricing.catering,
  });
  const totalMinor = minorAmount(pricing.totalMinor, 'REQUEST_PRICING_SNAPSHOT_INVALID');
  if (totalMinor !== safeSum([baseTotalMinor, normalizedEquipmentMinor])) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  const resolvedCurrency = resolveCurrency([
    basePricing.room.price,
    ...basePricing.services.map((line) => line.service.price),
    ...equipment.map((line) => line.equipment.price),
    ...(basePricing.catering.packageSelection
      ? [basePricing.catering.packageSelection.variant.price]
      : []),
    ...basePricing.catering.items
      .filter((line) => !line.includedByPackage)
      .map((line) => line.item.price),
  ], pricing.currency);
  if (totalMinor > 0 && pricing.currency !== resolvedCurrency) {
    invalid('REQUEST_PRICING_SNAPSHOT_INVALID');
  }
  return immutableCopy({
    currency: pricing.currency,
    totalMinor,
    breakdown: {
      roomMinor: basePricing.breakdown.roomMinor,
      servicesMinor: basePricing.breakdown.servicesMinor,
      equipmentMinor: normalizedEquipmentMinor,
      cateringPackageMinor: basePricing.breakdown.cateringPackageMinor,
      cateringItemsMinor: basePricing.breakdown.cateringItemsMinor,
    },
    room: basePricing.room,
    services: basePricing.services,
    equipment,
    catering: basePricing.catering,
  });
}

function sameConfigurationRevisions(left, right) {
  return CONFIGURATION_REVISION_KEYS.every((key) => left[key] === right[key]);
}

function assertSnapshotSelectionConsistency(details, pricing, schemaVersion) {
  if (
    !sameIdentifiers(
      details.serviceIds,
      pricing.services.map((line) => line.service.id),
    )
    || details.catering.participantCount !== pricing.catering.participantCount
    || !sameIdentifiers(
      details.catering.itemQuantities.map((entry) => entry.itemId),
      pricing.catering.items.map((line) => line.item.id),
    )
    || details.catering.itemQuantities.some((entry, index) => (
      entry.quantity !== pricing.catering.items[index].quantity
    ))
  ) invalid('REQUEST_SNAPSHOT_INVALID');
  if (
    schemaVersion === REQUEST_COMPOSITION_V3_SCHEMA_VERSION
    && !sameIdentifiers(
      details.equipmentIds,
      pricing.equipment.map((line) => line.equipment.id),
    )
  ) invalid('REQUEST_SNAPSHOT_INVALID');
  const detailsPackage = details.catering.packageSelection;
  const pricingPackage = pricing.catering.packageSelection;
  if (
    (detailsPackage === null) !== (pricingPackage === null)
    || (
      detailsPackage !== null
      && (
        detailsPackage.packageId !== pricingPackage.package.id
        || detailsPackage.variantId !== pricingPackage.variant.id
      )
    )
  ) invalid('REQUEST_SNAPSHOT_INVALID');
}

function snapshotDetails(draft, schemaVersion) {
  const details = {
    title: draft.title,
    specialRequirements: draft.specialRequirements,
    dietaryRequirements: draft.dietaryRequirements,
    serviceIds: draft.serviceIds,
  };
  if (schemaVersion === REQUEST_COMPOSITION_V3_SCHEMA_VERSION) {
    details.equipmentIds = draft.equipmentIds;
  }
  details.catering = {
    participantCount: draft.catering.participantCount,
    packageSelection: draft.catering.packageSelection,
    itemQuantities: draft.catering.itemQuantities,
  };
  return details;
}

function createVersionedRequestSnapshot({
  draft: draftValue,
  requestVersion,
  capturedAt,
  room,
  catalogueSnapshot,
  bookingPolicySnapshot,
  allocationSnapshot,
  revisions,
  defaultCurrency,
}, schemaVersion) {
  const draft = normalizeRequestCompositionDraft(draftValue, schemaVersion);
  const captured = utcInstant(capturedAt, 'REQUEST_SNAPSHOT_TIME_INVALID');
  const normalizedRevisions = configurationRevisions(revisions);
  const pricing = priceRequestCompositionForSchemaVersion({
    schemaVersion,
    draft,
    room,
    catalogueSnapshot,
    defaultCurrency,
  });
  const policy = normalizeTenantBookingPolicySnapshot(bookingPolicySnapshot);
  const allocations = normalizeAllocationSnapshot(allocationSnapshot);
  if (
    !sameConfigurationRevisions(normalizedRevisions, draft.configurationRevisions)
    || allocations.totalMinor !== pricing.totalMinor
    || allocations.currency !== pricing.currency
    || allocations.configurationRevision !== normalizedRevisions.costAllocation
    || catalogueSnapshot.catalogRevision !== normalizedRevisions.catalogue
    || catalogueSnapshot.capturedAt !== captured
    || policy.evaluatedAt !== captured
    || allocations.snapshottedAt !== captured
    || !sameIdentifiers(
      allocations.entries.map((entry) => entry.costCenterId),
      draft.allocations.map((entry) => entry.costCenterId),
    )
    || allocations.entries.some((entry, index) => (
      entry.percentageBasisPoints !== draft.allocations[index].percentageBasisPoints
    ))
  ) unavailable();
  return immutableCopy({
    schemaVersion,
    requestVersion: positiveVersion(requestVersion),
    capturedAt: captured,
    configurationRevisions: normalizedRevisions,
    details: snapshotDetails(draft, schemaVersion),
    pricing,
    policy,
    allocations,
  });
}

export function createRequestV2Snapshot(values) {
  return createVersionedRequestSnapshot(values, REQUEST_COMPOSITION_SCHEMA_VERSION);
}

export function createRequestV3Snapshot(values) {
  return createVersionedRequestSnapshot(values, REQUEST_COMPOSITION_V3_SCHEMA_VERSION);
}

export function createRequestCompositionSnapshot({ schemaVersion, ...values }) {
  if (!isSupportedRequestCompositionSchemaVersion(schemaVersion)) {
    invalid('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
  }
  return createVersionedRequestSnapshot(values, schemaVersion);
}

function normalizePersistedVersionedRequestSnapshot(value, expectedVersion, schemaVersion) {
  const snapshot = exactObject(value, [
    'schemaVersion',
    'requestVersion',
    'capturedAt',
    'configurationRevisions',
    'details',
    'pricing',
    'policy',
    'allocations',
  ], 'REQUEST_SNAPSHOT_INVALID');
  if (snapshot.schemaVersion !== schemaVersion) {
    invalid('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
  }
  const version = positiveVersion(snapshot.requestVersion);
  if (expectedVersion !== null && version !== expectedVersion) invalid('REQUEST_SNAPSHOT_INVALID');
  const capturedAt = utcInstant(snapshot.capturedAt, 'REQUEST_SNAPSHOT_INVALID');
  const revisions = configurationRevisions(snapshot.configurationRevisions);
  const details = schemaVersion === REQUEST_COMPOSITION_V3_SCHEMA_VERSION
    ? normalizeDetailsV3Snapshot(snapshot.details)
    : normalizeDetailsSnapshot(snapshot.details);
  const pricing = schemaVersion === REQUEST_COMPOSITION_V3_SCHEMA_VERSION
    ? normalizePricingV3Snapshot(snapshot.pricing)
    : normalizePricingSnapshot(snapshot.pricing);
  let policy;
  try {
    policy = normalizeTenantBookingPolicySnapshot(snapshot.policy);
  } catch (error) {
    if (error instanceof TenantBookingPolicyInputError) {
      invalid('REQUEST_POLICY_SNAPSHOT_INVALID');
    }
    throw error;
  }
  const allocations = normalizeAllocationSnapshot(snapshot.allocations);
  assertSnapshotSelectionConsistency(details, pricing, schemaVersion);
  if (
    allocations.totalMinor !== pricing.totalMinor
    || allocations.currency !== pricing.currency
    || allocations.configurationRevision !== revisions.costAllocation
    || allocations.snapshottedAt !== capturedAt
    || policy.evaluatedAt !== capturedAt
  ) invalid('REQUEST_SNAPSHOT_INVALID');
  return immutableCopy({
    schemaVersion,
    requestVersion: version,
    capturedAt,
    configurationRevisions: revisions,
    details,
    pricing,
    policy,
    allocations,
  });
}

export function normalizePersistedRequestV2Snapshot(value, expectedVersion = null) {
  return normalizePersistedVersionedRequestSnapshot(
    value,
    expectedVersion,
    REQUEST_COMPOSITION_SCHEMA_VERSION,
  );
}

export function normalizePersistedRequestV3Snapshot(value, expectedVersion = null) {
  return normalizePersistedVersionedRequestSnapshot(
    value,
    expectedVersion,
    REQUEST_COMPOSITION_V3_SCHEMA_VERSION,
  );
}

export function normalizePersistedRequestCompositionSnapshot(value, expectedVersion = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('REQUEST_SNAPSHOT_INVALID');
  }
  switch (value.schemaVersion) {
    case REQUEST_COMPOSITION_SCHEMA_VERSION:
      return normalizePersistedRequestV2Snapshot(value, expectedVersion);
    case REQUEST_COMPOSITION_V3_SCHEMA_VERSION:
      return normalizePersistedRequestV3Snapshot(value, expectedVersion);
    default:
      invalid('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
  }
}

function assertVersionedRequestDraftSnapshotConsistency(draftValue, snapshotValue, schemaVersion) {
  const draft = normalizeRequestCompositionDraft(draftValue, schemaVersion);
  const snapshot = schemaVersion === REQUEST_COMPOSITION_V3_SCHEMA_VERSION
    ? normalizePersistedRequestV3Snapshot(snapshotValue)
    : normalizePersistedRequestV2Snapshot(snapshotValue);
  const details = snapshot.details;
  const draftPackage = draft.catering.packageSelection;
  const snapshotPackage = details.catering.packageSelection;
  const allocationEntries = snapshot.allocations.entries;
  if (
    snapshot.schemaVersion !== schemaVersion
    || draft.roomId !== snapshot.pricing.room.id
    || draft.title !== details.title
    || draft.dietaryRequirements !== details.dietaryRequirements
    || draft.specialRequirements !== details.specialRequirements
    || draft.catering.participantCount !== details.catering.participantCount
    || !sameConfigurationRevisions(draft.configurationRevisions, snapshot.configurationRevisions)
    || !sameIdentifiers(draft.serviceIds, details.serviceIds)
    || (
      schemaVersion === REQUEST_COMPOSITION_V3_SCHEMA_VERSION
      && !sameIdentifiers(draft.equipmentIds, details.equipmentIds)
    )
    || (draftPackage === null) !== (snapshotPackage === null)
    || (
      draftPackage !== null
      && (
        draftPackage.packageId !== snapshotPackage.packageId
        || draftPackage.variantId !== snapshotPackage.variantId
      )
    )
    || draft.catering.itemQuantities.length !== details.catering.itemQuantities.length
    || draft.catering.itemQuantities.some((entry, index) => (
      entry.itemId !== details.catering.itemQuantities[index].itemId
      || entry.quantity !== details.catering.itemQuantities[index].quantity
    ))
    || draft.allocations.length !== allocationEntries.length
    || draft.allocations.some((entry, index) => (
      entry.costCenterId !== allocationEntries[index].costCenterId
      || entry.percentageBasisPoints !== allocationEntries[index].percentageBasisPoints
    ))
  ) invalid('REQUEST_PROPOSAL_SNAPSHOT_INVALID');
}

export function assertRequestV2DraftSnapshotConsistency(draftValue, snapshotValue) {
  return assertVersionedRequestDraftSnapshotConsistency(
    draftValue,
    snapshotValue,
    REQUEST_COMPOSITION_SCHEMA_VERSION,
  );
}

export function assertRequestV3DraftSnapshotConsistency(draftValue, snapshotValue) {
  return assertVersionedRequestDraftSnapshotConsistency(
    draftValue,
    snapshotValue,
    REQUEST_COMPOSITION_V3_SCHEMA_VERSION,
  );
}

export function assertRequestDraftSnapshotConsistency(draftValue, snapshotValue, schemaVersion) {
  if (!isSupportedRequestCompositionSchemaVersion(schemaVersion)) {
    invalid('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
  }
  return assertVersionedRequestDraftSnapshotConsistency(draftValue, snapshotValue, schemaVersion);
}

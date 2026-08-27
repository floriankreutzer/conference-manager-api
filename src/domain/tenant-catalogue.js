import { MoneyValidationError, normalizeMoney } from './money.js';

const UNSAFE_TEXT_CHARACTER = /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_APPLICABILITY_REFERENCES = 200;
const MAX_SELECTION_ENTRIES = 200;

const COLLECTION_LIMITS = Object.freeze({
  services: 200,
  equipment: 200,
  cateringPackages: 100,
  cateringItems: 300,
});

export class TenantCatalogueValidationError extends Error {
  constructor(code = 'TENANT_CATALOGUE_INVALID') {
    super(code);
    this.name = 'TenantCatalogueValidationError';
    this.code = code;
  }
}

function invalid(code) {
  throw new TenantCatalogueValidationError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
  return value;
}

function text(value, { min = 1, max, nullable = false, code }) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || UNSAFE_TEXT_CHARACTER.test(value)) invalid(code);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < min || normalized.length > max) invalid(code);
  return normalized;
}

function identifier(value, code = 'TENANT_CATALOGUE_IDENTIFIER_INVALID') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid(code);
  return value;
}

function identifiers(value, { max = MAX_APPLICABILITY_REFERENCES, code }) {
  if (!Array.isArray(value) || value.length > max) invalid(code);
  const normalized = value.map((entry) => identifier(entry, code));
  if (new Set(normalized).size !== normalized.length) invalid(code);
  return Object.freeze(normalized.sort());
}

function price(value) {
  try {
    return normalizeMoney(value);
  } catch (error) {
    if (error instanceof MoneyValidationError) invalid(error.code);
    throw error;
  }
}

function commonEntity(value, { code, extraKeys = [] }) {
  exactObject(value, [
    'id',
    'name',
    'description',
    'price',
    'active',
    'order',
    'siteIds',
    'roomIds',
    ...extraKeys,
  ], code);
  if (typeof value.active !== 'boolean') invalid(`${code}_ACTIVE`);
  if (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 100_000) {
    invalid(`${code}_ORDER`);
  }
  return {
    id: identifier(value.id, `${code}_ID`),
    name: text(value.name, { max: 160, code: `${code}_NAME` }),
    description: text(value.description, {
      max: 1000,
      nullable: true,
      code: `${code}_DESCRIPTION`,
    }),
    price: price(value.price),
    active: value.active,
    order: value.order,
    siteIds: identifiers(value.siteIds, { code: `${code}_SITE_IDS` }),
    roomIds: identifiers(value.roomIds, { code: `${code}_ROOM_IDS` }),
  };
}

function simpleEntity(value, kind) {
  return Object.freeze(commonEntity(value, { code: `TENANT_CATALOGUE_${kind}_INVALID` }));
}

function normalizeVariant(value) {
  exactObject(
    value,
    ['id', 'name', 'description', 'price', 'active', 'order'],
    'TENANT_CATALOGUE_VARIANT_INVALID',
  );
  if (typeof value.active !== 'boolean') invalid('TENANT_CATALOGUE_VARIANT_ACTIVE_INVALID');
  if (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 100_000) {
    invalid('TENANT_CATALOGUE_VARIANT_ORDER_INVALID');
  }
  return Object.freeze({
    id: identifier(value.id, 'TENANT_CATALOGUE_VARIANT_ID_INVALID'),
    name: text(value.name, { max: 160, code: 'TENANT_CATALOGUE_VARIANT_NAME_INVALID' }),
    description: text(value.description, {
      max: 1000,
      nullable: true,
      code: 'TENANT_CATALOGUE_VARIANT_DESCRIPTION_INVALID',
    }),
    price: price(value.price),
    active: value.active,
    order: value.order,
  });
}

function normalizePackage(value) {
  const normalized = commonEntity(value, {
    code: 'TENANT_CATALOGUE_PACKAGE_INVALID',
    extraKeys: ['itemIds', 'variants'],
  });
  normalized.itemIds = identifiers(value.itemIds, {
    max: 300,
    code: 'TENANT_CATALOGUE_PACKAGE_ITEM_IDS_INVALID',
  });
  if (!Array.isArray(value.variants) || value.variants.length > 20) {
    invalid('TENANT_CATALOGUE_VARIANTS_INVALID');
  }
  const variants = value.variants.map(normalizeVariant);
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    invalid('TENANT_CATALOGUE_VARIANT_ID_DUPLICATE');
  }
  normalized.variants = Object.freeze(
    variants.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
  );
  return Object.freeze(normalized);
}

function collection(value, key, normalizeEntry) {
  if (!Array.isArray(value) || value.length > COLLECTION_LIMITS[key]) {
    invalid(`TENANT_CATALOGUE_${key.toUpperCase()}_INVALID`);
  }
  const normalized = value.map(normalizeEntry);
  if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
    invalid(`TENANT_CATALOGUE_${key.toUpperCase()}_ID_DUPLICATE`);
  }
  return Object.freeze(
    normalized.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
  );
}

function assertPackageReferences(catalogue) {
  const itemById = new Map(catalogue.cateringItems.map((item) => [item.id, item]));
  for (const cateringPackage of catalogue.cateringPackages) {
    for (const itemId of cateringPackage.itemIds) {
      const item = itemById.get(itemId);
      if (!item || (cateringPackage.active && !item.active)) {
        invalid('TENANT_CATALOGUE_PACKAGE_ITEM_REFERENCE_INVALID');
      }
    }
  }
}

export function normalizeTenantCatalogue(value) {
  exactObject(
    value,
    ['services', 'equipment', 'cateringPackages', 'cateringItems'],
    'TENANT_CATALOGUE_INVALID',
  );
  const normalized = Object.freeze({
    services: collection(value.services, 'services', (entry) => simpleEntity(entry, 'SERVICE')),
    equipment: collection(value.equipment, 'equipment', (entry) => simpleEntity(entry, 'EQUIPMENT')),
    cateringPackages: collection(value.cateringPackages, 'cateringPackages', normalizePackage),
    cateringItems: collection(value.cateringItems, 'cateringItems', (entry) => {
      return simpleEntity(entry, 'CATERING_ITEM');
    }),
  });
  assertPackageReferences(normalized);
  return normalized;
}

function activeCount(entries) {
  return entries.filter((entry) => entry.active).length;
}

export function tenantCatalogueSummary(value) {
  const catalogue = normalizeTenantCatalogue(value);
  return Object.freeze({
    serviceCount: catalogue.services.length,
    activeServiceCount: activeCount(catalogue.services),
    equipmentCount: catalogue.equipment.length,
    activeEquipmentCount: activeCount(catalogue.equipment),
    packageCount: catalogue.cateringPackages.length,
    activePackageCount: activeCount(catalogue.cateringPackages),
    cateringItemCount: catalogue.cateringItems.length,
    activeCateringItemCount: activeCount(catalogue.cateringItems),
  });
}

function normalizeSelection(value) {
  exactObject(
    value,
    ['serviceIds', 'equipmentIds', 'cateringItemIds', 'catering'],
    'TENANT_CATALOGUE_SELECTION_INVALID',
  );
  const catering = value.catering;
  if (!Array.isArray(catering) || catering.length > MAX_SELECTION_ENTRIES) {
    invalid('TENANT_CATALOGUE_SELECTION_CATERING_INVALID');
  }
  return Object.freeze({
    serviceIds: identifiers(value.serviceIds, {
      max: MAX_SELECTION_ENTRIES,
      code: 'TENANT_CATALOGUE_SELECTION_SERVICES_INVALID',
    }),
    equipmentIds: identifiers(value.equipmentIds, {
      max: MAX_SELECTION_ENTRIES,
      code: 'TENANT_CATALOGUE_SELECTION_EQUIPMENT_INVALID',
    }),
    cateringItemIds: identifiers(value.cateringItemIds, {
      max: MAX_SELECTION_ENTRIES,
      code: 'TENANT_CATALOGUE_SELECTION_ITEMS_INVALID',
    }),
    catering: Object.freeze(catering.map((entry) => {
      exactObject(
        entry,
        ['packageId', 'variantId', 'itemIds'],
        'TENANT_CATALOGUE_SELECTION_CATERING_INVALID',
      );
      if (entry.variantId !== null) identifier(
        entry.variantId,
        'TENANT_CATALOGUE_SELECTION_VARIANT_INVALID',
      );
      return Object.freeze({
        packageId: identifier(
          entry.packageId,
          'TENANT_CATALOGUE_SELECTION_PACKAGE_INVALID',
        ),
        variantId: entry.variantId,
        itemIds: identifiers(entry.itemIds, {
          max: MAX_SELECTION_ENTRIES,
          code: 'TENANT_CATALOGUE_SELECTION_ITEMS_INVALID',
        }),
      });
    })),
  });
}

function applicable(entry, siteId, roomId) {
  return entry.active
    && (entry.siteIds.length === 0 || entry.siteIds.includes(siteId))
    && (entry.roomIds.length === 0 || entry.roomIds.includes(roomId));
}

function selected(entries, ids, siteId, roomId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry || !applicable(entry, siteId, roomId)) {
      invalid('TENANT_CATALOGUE_SELECTION_UNAVAILABLE');
    }
    return entry;
  });
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

function snapshotEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    price: entry.price,
  };
}

export function snapshotTenantCatalogueSelection({
  catalogue: catalogueValue,
  revision,
  selection: selectionValue,
  siteId: siteIdValue,
  roomId: roomIdValue,
  capturedAt,
}) {
  const catalogue = normalizeTenantCatalogue(catalogueValue);
  const selection = normalizeSelection(selectionValue);
  const siteId = identifier(siteIdValue, 'TENANT_CATALOGUE_SELECTION_SITE_INVALID');
  const roomId = identifier(roomIdValue, 'TENANT_CATALOGUE_SELECTION_ROOM_INVALID');
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('TENANT_CATALOGUE_REVISION_INVALID');
  if (typeof capturedAt !== 'string' || !capturedAt.endsWith('Z') || !Number.isFinite(Date.parse(capturedAt))) {
    invalid('TENANT_CATALOGUE_SNAPSHOT_TIME_INVALID');
  }

  const packages = new Map(catalogue.cateringPackages.map((entry) => [entry.id, entry]));
  const items = new Map(catalogue.cateringItems.map((entry) => [entry.id, entry]));
  const catering = selection.catering.map((choice) => {
    const cateringPackage = packages.get(choice.packageId);
    if (!cateringPackage || !applicable(cateringPackage, siteId, roomId)) {
      invalid('TENANT_CATALOGUE_SELECTION_UNAVAILABLE');
    }
    const variant = choice.variantId === null
      ? null
      : cateringPackage.variants.find((candidate) => candidate.id === choice.variantId);
    if (choice.variantId !== null && (!variant || !variant.active)) {
      invalid('TENANT_CATALOGUE_SELECTION_UNAVAILABLE');
    }
    const selectedItems = choice.itemIds.map((itemId) => {
      const item = items.get(itemId);
      if (
        !item
        || !applicable(item, siteId, roomId)
        || !cateringPackage.itemIds.includes(itemId)
      ) {
        invalid('TENANT_CATALOGUE_SELECTION_UNAVAILABLE');
      }
      return snapshotEntry(item);
    });
    return {
      package: snapshotEntry(cateringPackage),
      variant: variant ? snapshotEntry(variant) : null,
      items: selectedItems,
    };
  });

  return immutableCopy({
    schemaVersion: 1,
    catalogRevision: revision,
    capturedAt,
    siteId,
    roomId,
    services: selected(catalogue.services, selection.serviceIds, siteId, roomId).map(snapshotEntry),
    equipment: selected(catalogue.equipment, selection.equipmentIds, siteId, roomId).map(snapshotEntry),
    cateringItems: selected(
      catalogue.cateringItems,
      selection.cateringItemIds,
      siteId,
      roomId,
    ).map(snapshotEntry),
    catering,
  });
}

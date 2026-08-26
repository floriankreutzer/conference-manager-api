import {
  approvedValue,
  boundedInteger,
  boundedText,
  exactObject,
  nullableBoundedText,
  requireConfigurationSnapshot,
  safeIdentifier,
  TenantConfigurationInputError,
  uniqueStringList,
} from './protocol.js';

const CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF']);
const BILLING_UNITS = new Set(['per_booking', 'per_person', 'per_day', 'per_unit']);
const ENTRY_LIMIT = 500;

function retainedIds(current, proposed, code) {
  const proposedIds = new Set(proposed.map((entry) => entry.id));
  if (current.some((entry) => !proposedIds.has(entry.id))) {
    throw new TenantConfigurationInputError(code);
  }
}

function normalizePricedEntry(value, ids, type) {
  const entry = exactObject(
    value,
    [
      'id',
      'name',
      'description',
      'active',
      'priceMinor',
      'currency',
      'billingUnit',
      'dietaryTags',
      'allergens',
    ],
    type === 'package' ? ['itemIds'] : [],
  );
  const id = safeIdentifier(entry.id, 'TENANT_CATALOG_ID_INVALID');
  if (ids.has(id)) throw new TenantConfigurationInputError('TENANT_CATALOG_ID_DUPLICATE');
  ids.add(id);
  if (typeof entry.active !== 'boolean') {
    throw new TenantConfigurationInputError('TENANT_CATALOG_ACTIVE_INVALID');
  }
  const normalized = {
    id,
    name: boundedText(entry.name, {
      minimum: 1,
      maximum: 160,
      code: 'TENANT_CATALOG_NAME_INVALID',
    }),
    description: nullableBoundedText(entry.description, {
      minimum: 1,
      maximum: 1_000,
      code: 'TENANT_CATALOG_DESCRIPTION_INVALID',
    }),
    active: entry.active,
    priceMinor: boundedInteger(entry.priceMinor, {
      minimum: 0,
      maximum: 1_000_000_000_000,
      code: 'TENANT_CATALOG_PRICE_INVALID',
    }),
    currency: approvedValue(entry.currency, CURRENCIES, 'TENANT_CATALOG_CURRENCY_INVALID'),
    billingUnit: approvedValue(
      entry.billingUnit,
      BILLING_UNITS,
      'TENANT_CATALOG_BILLING_UNIT_INVALID',
    ),
    dietaryTags: uniqueStringList(entry.dietaryTags, {
      limit: 30,
      itemMaximum: 80,
      code: 'TENANT_CATALOG_DIETARY_TAGS_INVALID',
    }),
    allergens: uniqueStringList(entry.allergens, {
      limit: 30,
      itemMaximum: 80,
      code: 'TENANT_CATALOG_ALLERGENS_INVALID',
    }),
  };
  if (type === 'package') {
    normalized.itemIds = Object.freeze(entry.itemIds.map((itemId) => (
      safeIdentifier(itemId, 'TENANT_CATALOG_PACKAGE_ITEM_INVALID')
    )));
    if (new Set(normalized.itemIds).size !== normalized.itemIds.length || normalized.itemIds.length > 100) {
      throw new TenantConfigurationInputError('TENANT_CATALOG_PACKAGE_ITEM_INVALID');
    }
  }
  return Object.freeze(normalized);
}

function normalizeCollection(value, type) {
  if (!Array.isArray(value) || value.length > ENTRY_LIMIT) {
    throw new TenantConfigurationInputError('TENANT_CATALOG_COLLECTION_INVALID');
  }
  const ids = new Set();
  return Object.freeze(value.map((entry) => normalizePricedEntry(entry, ids, type)));
}

export function normalizeCatalogConfiguration(value, currentSnapshot = null) {
  exactObject(value, ['services', 'cateringPackages', 'cateringItems']);
  const services = normalizeCollection(value.services, 'service');
  const cateringPackages = normalizeCollection(value.cateringPackages, 'package');
  const cateringItems = normalizeCollection(value.cateringItems, 'item');
  const itemIds = new Set(cateringItems.map((item) => item.id));
  for (const candidate of cateringPackages) {
    if (candidate.itemIds.some((itemId) => !itemIds.has(itemId))) {
      throw new TenantConfigurationInputError('TENANT_CATALOG_PACKAGE_ITEM_NOT_FOUND');
    }
  }
  if (currentSnapshot) {
    retainedIds(currentSnapshot.services || [], services, 'TENANT_SERVICE_ARCHIVE_REQUIRED');
    retainedIds(
      currentSnapshot.cateringPackages || [],
      cateringPackages,
      'TENANT_CATERING_PACKAGE_ARCHIVE_REQUIRED',
    );
    retainedIds(
      currentSnapshot.cateringItems || [],
      cateringItems,
      'TENANT_CATERING_ITEM_ARCHIVE_REQUIRED',
    );
  }
  return requireConfigurationSnapshot({ services, cateringPackages, cateringItems });
}

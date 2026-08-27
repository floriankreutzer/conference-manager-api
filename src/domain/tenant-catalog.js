const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BILLING_UNITS = new Set(['per_booking', 'per_person', 'per_day', 'per_unit']);
const CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF']);

export class TenantCatalogInputError extends Error {
  constructor(code = 'TENANT_CATALOG_INVALID') {
    super(code);
    this.name = 'TenantCatalogInputError';
    this.code = code;
  }
}
function invalid(code) { throw new TenantCatalogInputError(code); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('TENANT_CATALOG_INVALID');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid('TENANT_CATALOG_INVALID');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalid('TENANT_CATALOG_INVALID');
  return value;
}
function text(value, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') invalid('TENANT_CATALOG_INVALID');
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max || CONTROL_CHARACTER.test(normalized)) invalid('TENANT_CATALOG_INVALID');
  return normalized;
}
function price(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) invalid('TENANT_CATALOG_PRICE_INVALID');
  return value;
}
function currency(value) {
  if (!CURRENCIES.has(value)) invalid('TENANT_CATALOG_CURRENCY_INVALID');
  return value;
}
function billing(value) {
  if (!BILLING_UNITS.has(value)) invalid('TENANT_CATALOG_BILLING_UNIT_INVALID');
  return value;
}
function order(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000) invalid('TENANT_CATALOG_INVALID');
  return value;
}
function basic(entry, defaultBilling) {
  const item = exact(entry, ['id','name','description','active','priceMinor','currency','billingUnit','sortOrder']);
  if (typeof item.active !== 'boolean') invalid('TENANT_CATALOG_INVALID');
  return Object.freeze({
    id: id(item.id),
    name: text(item.name, 160),
    description: text(item.description, 1000, true),
    active: item.active,
    priceMinor: price(item.priceMinor),
    currency: currency(item.currency),
    billingUnit: billing(item.billingUnit ?? defaultBilling),
    sortOrder: order(item.sortOrder),
  });
}
function unique(items) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) invalid('TENANT_CATALOG_INVALID');
  return Object.freeze(items);
}

export function normalizeTenantCatalog(value) {
  const input = exact(value, ['services','cateringPackages','cateringItems']);
  if (!Array.isArray(input.services) || input.services.length > 500
      || !Array.isArray(input.cateringItems) || input.cateringItems.length > 1000
      || !Array.isArray(input.cateringPackages) || input.cateringPackages.length > 500) {
    invalid('TENANT_CATALOG_INVALID');
  }
  const services = unique(input.services.map((item) => basic(item, 'per_booking')));
  const cateringItems = unique(input.cateringItems.map((item) => basic(item, 'per_unit')));
  const itemIds = new Set(cateringItems.map((item) => item.id));
  const cateringPackages = unique(input.cateringPackages.map((entry) => {
    const item = exact(entry, ['id','name','description','active','priceMinor','currency','billingUnit','sortOrder','items']);
    const core = basic({
      id: item.id, name: item.name, description: item.description, active: item.active,
      priceMinor: item.priceMinor, currency: item.currency, billingUnit: item.billingUnit, sortOrder: item.sortOrder,
    }, 'per_booking');
    if (!Array.isArray(item.items) || item.items.length > 200) invalid('TENANT_CATALOG_INVALID');
    const seen = new Set();
    const items = item.items.map((line) => {
      const normalized = exact(line, ['itemId','quantity']);
      const itemId = id(normalized.itemId);
      if (!itemIds.has(itemId) || seen.has(itemId)) invalid('TENANT_CATALOG_REFERENCE_INVALID');
      seen.add(itemId);
      if (!Number.isSafeInteger(normalized.quantity) || normalized.quantity < 1 || normalized.quantity > 1000) invalid('TENANT_CATALOG_INVALID');
      return Object.freeze({ itemId, quantity: normalized.quantity });
    });
    return Object.freeze({ ...core, items: Object.freeze(items) });
  }));
  return Object.freeze({ services, cateringPackages, cateringItems });
}

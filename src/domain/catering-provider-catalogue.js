import { isInternalUuid } from './identifiers.js';
import { normalizeMoney } from './money.js';
import { normalizeCateringOrderTotal } from './catering-order-money.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNSAFE = /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const MAX_MINUTES = 525600;
function invalid() { throw new TypeError('CATERING_PROVIDER_CATALOGUE_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function array(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  return value;
}
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function text(value, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed() || UNSAFE.test(value)) invalid();
  const normalized = value.trim().normalize('NFC');
  if (!normalized.length || normalized.length > maximum) invalid();
  return normalized;
}
function optionalMoney(value, aggregate = false) {
  if (value === null) return null;
  record(value, ['amountMinor','currency']);
  try { return aggregate ? normalizeCateringOrderTotal(value) : normalizeMoney(value); } catch { invalid(); }
}
function minutes(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MINUTES) invalid();
  return value;
}
function terms(value) {
  record(value, ['minimumLeadTimeMinutes','minimumOrderValue','changeCutoffMinutes','cancelCutoffMinutes']);
  return Object.freeze({ minimumLeadTimeMinutes: minutes(value.minimumLeadTimeMinutes),
    minimumOrderValue: optionalMoney(value.minimumOrderValue, true),
    changeCutoffMinutes: minutes(value.changeCutoffMinutes), cancelCutoffMinutes: minutes(value.cancelCutoffMinutes) });
}
const compare = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
function unique(values) { if (new Set(values.map((value) => value.id)).size !== values.length) invalid(); return values; }
function product(value) {
  record(value, ['id','name','description','providerPrice']);
  return Object.freeze({ id: identifier(value.id), name: text(value.name, 160),
    description: text(value.description, 1000, true), providerPrice: optionalMoney(value.providerPrice) });
}
function packageValue(value, items) {
  record(value, ['id','name','description','providerPrice','itemIds','variants']);
  const itemIds = array(value.itemIds, 300).map(identifier);
  if (new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !items.has(id))) invalid();
  const variants = unique(array(value.variants, 20).map(product));
  return Object.freeze({ id: identifier(value.id), name: text(value.name, 160), description: text(value.description, 1000, true),
    providerPrice: optionalMoney(value.providerPrice), itemIds: Object.freeze(itemIds.sort()),
    variants: Object.freeze(variants.sort(compare)) });
}

// Provider response values only. Scope must be independently resolved by the
// authorized adapter/use case. This neither publishes nor activates an offer,
// changes a selling price, attests availability, or authorizes an order.
export function normalizeCateringProviderCatalogue(value, scope) {
  record(scope, ['tenantId','integrationId']);
  if (!isInternalUuid(scope.tenantId) || !isInternalUuid(scope.integrationId)) invalid();
  record(value, ['schemaVersion','sourceVersion','items','packages','terms']);
  if (value.schemaVersion !== 1) invalid();
  const sourceVersion = text(value.sourceVersion, 160, true);
  const items = unique(array(value.items, 300).map(product));
  const itemIds = new Set(items.map((entry) => entry.id));
  const packages = unique(array(value.packages, 100).map((entry) => packageValue(entry, itemIds)));
  return Object.freeze({ schemaVersion: 1, tenantId: scope.tenantId.toLowerCase(), integrationId: scope.integrationId.toLowerCase(),
    sourceVersion, items: Object.freeze(items.sort(compare)), packages: Object.freeze(packages.sort(compare)), terms: terms(value.terms) });
}

// A Manager records an actually received manual source. Expected revisions and
// attestation are command intent, never supplier identity or publication proof.
export function normalizeCateringProviderCatalogueReceiptCommand(value, scope) {
  record(value, ['schemaVersion','commandId','expectedRevision','expectedConfigurationRevision',
    'reference','attestReceivedFromSupplier','source']);
  if (value.schemaVersion !== 1 || !isInternalUuid(value.commandId) || value.attestReceivedFromSupplier !== true
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
    || value.expectedRevision > Number.MAX_SAFE_INTEGER - 2
    || !Number.isSafeInteger(value.expectedConfigurationRevision) || value.expectedConfigurationRevision < 1
    || value.expectedConfigurationRevision >= Number.MAX_SAFE_INTEGER) invalid();
  const source = normalizeCateringProviderCatalogue(value.source, scope);
  return Object.freeze({ schemaVersion: 1, commandId: value.commandId.toLowerCase(), expectedRevision: value.expectedRevision,
    expectedConfigurationRevision: value.expectedConfigurationRevision, reference: text(value.reference, 160),
    attestReceivedFromSupplier: true, source: Object.freeze({ schemaVersion: 1, sourceVersion: source.sourceVersion,
      items: source.items, packages: source.packages, terms: source.terms }) });
}

// Bounded history metadata deliberately omits product text and unit costs.
export function normalizeCateringProviderCatalogueMetadata(value) {
  record(value, ['sourceVersion','itemCount','packageCount','terms']);
  if (!Number.isSafeInteger(value.itemCount) || value.itemCount < 0 || value.itemCount > 300
    || !Number.isSafeInteger(value.packageCount) || value.packageCount < 0 || value.packageCount > 100) invalid();
  return Object.freeze({ sourceVersion: text(value.sourceVersion,160,true), itemCount: value.itemCount,
    packageCount: value.packageCount, terms: terms(value.terms) });
}

// Reusable provider business terms only. Unknown values remain explicit null;
// this neither proves receipt/publication nor supplier availability or approval.
export function normalizeCateringProviderTerms(value) {
  return terms(value);
}

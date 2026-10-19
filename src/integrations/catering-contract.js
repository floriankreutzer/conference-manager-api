import { isInternalUuid } from '../domain/identifiers.js';
import { CATERING_MAX_ORDER_POSITIONS } from '../domain/catering-order-limits.js';
import { normalizeProviderDescriptor } from './provider-registry.js';

const CATERING_METHODS = Object.freeze({
  'catering.catalogue': 'readCatalogue',
  'catering.availability': 'lookupAvailability',
  'catering.order': 'placeOrder',
  'catering.update': 'changeOrder',
  'catering.cancel': 'cancelOrder',
  'catering.status': 'readOrderStatus',
});
const POSITION_OUTCOMES = new Set(['pending', 'confirmed', 'rejected', 'substitution_proposed']);

function invalidReceipt() {
  throw new TypeError('CATERING_RECEIPT_INVALID');
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidReceipt();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) invalidReceipt();
  for (const key of ownKeys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalidReceipt();
  }
}

function positionArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > CATERING_MAX_ORDER_POSITIONS
    || Reflect.ownKeys(value).length !== value.length + 1) invalidReceipt();
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalidReceipt();
  }
  return value;
}

export function assertCateringProvider(descriptor, provider) {
  const registration = normalizeProviderDescriptor(descriptor);
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('CATERING_PROVIDER_REQUIRED');
  }
  let declared = false;
  for (const [capability, method] of Object.entries(CATERING_METHODS)) {
    const mode = registration.capabilities[capability] ?? 'unsupported';
    if (mode !== 'unsupported') declared = true;
    if (mode === 'api' && typeof provider[method] !== 'function') {
      throw new TypeError('CATERING_PROVIDER_METHOD_REQUIRED');
    }
  }
  if (!declared) throw new TypeError('CATERING_PROVIDER_CAPABILITY_REQUIRED');
  return provider;
}

// Expected scope comes from the authorized use case's persisted order/version, never provider input.
export function normalizeCateringReceipt(value, expected) {
  exactRecord(expected, ['orderId', 'orderVersion', 'positionIds']);
  if (!isInternalUuid(expected.orderId) || !Number.isSafeInteger(expected.orderVersion) || expected.orderVersion < 1) {
    invalidReceipt();
  }
  if (!positionArray(expected.positionIds).every(isInternalUuid)) invalidReceipt();
  const expectedIds = new Set(expected.positionIds);
  if (expectedIds.size !== expected.positionIds.length) invalidReceipt();

  exactRecord(value, ['orderId', 'orderVersion', 'positions']);
  if (value.orderId !== expected.orderId || value.orderVersion !== expected.orderVersion) invalidReceipt();
  if (positionArray(value.positions).length !== expectedIds.size) invalidReceipt();
  const seen = new Set();
  const counts = { confirmed: 0, rejected: 0, pending: 0, substitution_proposed: 0 };
  const positions = Array.from(value.positions, (position) => {
    exactRecord(position, ['positionId', 'outcome']);
    if (!expectedIds.has(position.positionId) || seen.has(position.positionId)
      || !POSITION_OUTCOMES.has(position.outcome)) invalidReceipt();
    seen.add(position.positionId);
    counts[position.outcome] += 1;
    return Object.freeze({ positionId: position.positionId, outcome: position.outcome });
  });
  return Object.freeze({
    orderId: expected.orderId,
    orderVersion: expected.orderVersion,
    positions: Object.freeze(positions),
    counts: Object.freeze(counts),
  });
}

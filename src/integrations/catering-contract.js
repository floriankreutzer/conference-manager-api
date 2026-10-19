import { normalizeProviderDescriptor } from './provider-registry.js';

const CATERING_METHODS = Object.freeze({
  'catering.catalogue': 'readCatalogue',
  'catering.availability': 'lookupAvailability',
  'catering.order': 'placeOrder',
  'catering.update': 'changeOrder',
  'catering.cancel': 'cancelOrder',
  'catering.status': 'readOrderStatus',
});
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

export { normalizeCateringReceipt } from '../domain/catering-receipt.js';

const DELIVERY_FAILURE_CODES = new Set(['timeout','throttled','unavailable','authorization','validation','response_invalid','unknown']);
const DELIVERY_FAILURE_OUTCOMES = new Set(['not_sent','rejected','unknown']);

// Only a trusted adapter may assert that a write was demonstrably not sent.
// Arbitrary exceptions always mean unknown outcome to the application.
export class CateringDeliveryError extends Error {
  constructor(code, { outcome = 'unknown', retryable = false, retryAfterMs = null } = {}) {
    if (!DELIVERY_FAILURE_CODES.has(code) || !DELIVERY_FAILURE_OUTCOMES.has(outcome) || typeof retryable !== 'boolean'
      || (retryable && outcome !== 'not_sent') || (retryAfterMs !== null
        && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 300000))) {
      throw new TypeError('CATERING_DELIVERY_CLASSIFICATION_INVALID');
    }
    super('CATERING_PROVIDER_DELIVERY_UNAVAILABLE');
    this.name = 'CateringDeliveryError'; this.code = code; this.outcome = outcome;
    this.retryable = retryable; this.retryAfterMs = retryAfterMs; Object.freeze(this);
  }
}

import { CATERING_INITIAL_ORDER_MODE } from '../domain/catering-approval-policy.js';
import { INTEGRATION_CAPABILITY, normalizeProviderDescriptor } from './provider-registry.js';

const INITIAL_MODES = new Set(Object.values(CATERING_INITIAL_ORDER_MODE));
const CATERING_CAPABILITIES = new Set(Object.values(INTEGRATION_CAPABILITY).filter((value) => value.startsWith('catering.')));
const MODES = new Set(['api', 'manual', 'unsupported']);

function invalid() {
  throw new TypeError('CATERING_CONFIGURATION_INVALID');
}

function dataRecord(value, allowedKeys, requiredCount = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowedKeys.size || (requiredCount !== null && keys.length !== requiredCount)) invalid();
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!allowedKeys.has(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
}

// Descriptor selection is server-owned; this positive schema is not a Tenant Admin authorization decision.
export function normalizeCateringConfiguration(value, descriptor) {
  const registration = normalizeProviderDescriptor(descriptor);
  if (!Object.keys(registration.capabilities).some((capability) => CATERING_CAPABILITIES.has(capability))) invalid();
  dataRecord(value, new Set(['initialOrderMode', 'capabilities']), 2);
  if (!INITIAL_MODES.has(value.initialOrderMode)) invalid();
  dataRecord(value.capabilities, CATERING_CAPABILITIES);
  const capabilities = {};
  for (const capability of CATERING_CAPABILITIES) {
    const requested = Object.hasOwn(value.capabilities, capability) ? value.capabilities[capability] : 'unsupported';
    const supported = registration.capabilities[capability] ?? 'unsupported';
    if (!MODES.has(requested) || (requested !== 'unsupported' && requested !== supported)) invalid();
    capabilities[capability] = requested;
  }
  return Object.freeze({
    providerId: registration.id,
    initialOrderMode: value.initialOrderMode,
    capabilities: Object.freeze(capabilities),
  });
}

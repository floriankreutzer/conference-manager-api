export const INTEGRATION_CAPABILITY = Object.freeze({
  CALENDAR_AVAILABILITY: 'calendar.availability',
  CALENDAR_RESERVATION: 'calendar.reservation',
  CALENDAR_CREATE: 'calendar.create',
  CALENDAR_UPDATE: 'calendar.update',
  CALENDAR_CANCEL: 'calendar.cancel',
  CATERING_CATALOGUE: 'catering.catalogue',
  CATERING_AVAILABILITY: 'catering.availability',
  CATERING_ORDER: 'catering.order',
  CATERING_UPDATE: 'catering.update',
  CATERING_CANCEL: 'catering.cancel',
  CATERING_STATUS: 'catering.status',
});

export const INTEGRATION_MODE = Object.freeze({ API: 'api', MANUAL: 'manual', UNSUPPORTED: 'unsupported' });

const CAPABILITIES = new Set(Object.values(INTEGRATION_CAPABILITY));
const MODES = new Set(Object.values(INTEGRATION_MODE));
const RUNTIMES = new Set(['production', 'demo']);
const PROVIDER_ID = /^[a-z][a-z0-9_]{1,47}$/;
const MAX_PROVIDERS = 32;

function record(value, allowedKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowedKeys.size) throw new TypeError(code);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!allowedKeys.has(key) || !property.enumerable || !Object.hasOwn(property, 'value')) throw new TypeError(code);
  }
  return value;
}

function requireCapability(capability) {
  if (!CAPABILITIES.has(capability)) throw new TypeError('INTEGRATION_CAPABILITY_INVALID');
}

export function normalizeProviderDescriptor(value) {
  record(value, new Set(['id', 'runtime', 'capabilities']), 'INTEGRATION_DESCRIPTOR_INVALID');
  if (typeof value.id !== 'string' || !PROVIDER_ID.test(value.id)) throw new TypeError('INTEGRATION_PROVIDER_ID_INVALID');
  if (!RUNTIMES.has(value.runtime)) throw new TypeError('INTEGRATION_RUNTIME_INVALID');
  record(value.capabilities, CAPABILITIES, 'INTEGRATION_CAPABILITIES_INVALID');
  const entries = Object.entries(value.capabilities);
  if (entries.length === 0) throw new TypeError('INTEGRATION_CAPABILITIES_REQUIRED');
  const capabilities = {};
  for (const [capability, mode] of entries) {
    if (!MODES.has(mode)) throw new TypeError('INTEGRATION_MODE_INVALID');
    capabilities[capability] = mode;
  }
  return Object.freeze({ id: value.id, runtime: value.runtime, capabilities: Object.freeze(capabilities) });
}

// Trusted composition metadata only: registration never authorizes a Tenant or invokes an adapter.
export function createProviderRegistry({ runtime, descriptors } = {}) {
  if (!RUNTIMES.has(runtime)) throw new TypeError('INTEGRATION_RUNTIME_INVALID');
  if (!Array.isArray(descriptors) || descriptors.length > MAX_PROVIDERS) {
    throw new TypeError('INTEGRATION_REGISTRY_INVALID');
  }
  const providers = new Map();
  for (const source of descriptors) {
    const descriptor = normalizeProviderDescriptor(source);
    if (descriptor.runtime !== runtime) throw new TypeError('INTEGRATION_RUNTIME_MISMATCH');
    if (providers.has(descriptor.id)) throw new TypeError('INTEGRATION_PROVIDER_DUPLICATE');
    providers.set(descriptor.id, descriptor);
  }

  function get(providerId) {
    if (typeof providerId !== 'string' || !providers.has(providerId)) {
      throw new TypeError('INTEGRATION_PROVIDER_UNKNOWN');
    }
    return providers.get(providerId);
  }

  function capabilityMode(providerId, capability) {
    requireCapability(capability);
    return get(providerId).capabilities[capability] ?? INTEGRATION_MODE.UNSUPPORTED;
  }

  return Object.freeze({
    list: () => Object.freeze([...providers.values()]),
    get,
    capabilityMode,
    requireMode(providerId, capability, mode) {
      if (![INTEGRATION_MODE.API, INTEGRATION_MODE.MANUAL].includes(mode)) {
        throw new TypeError('INTEGRATION_REQUIRED_MODE_INVALID');
      }
      if (capabilityMode(providerId, capability) !== mode) throw new TypeError('INTEGRATION_CAPABILITY_UNAVAILABLE');
      return get(providerId);
    },
  });
}

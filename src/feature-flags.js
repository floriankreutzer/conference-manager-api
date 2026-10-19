// Rollout is server-owned configuration; enabling a flag grants no role, object or workflow authority.
export const FEATURE_FLAG_DEFAULTS = Object.freeze({ 'catering.configuration': false });

export function loadFeatureFlags(env = {}) {
  const value = env.CATERING_CONFIGURATION_ENABLED;
  if (value !== undefined && !['true', 'false'].includes(value)) {
    throw new TypeError('CATERING_CONFIGURATION_ENABLED_INVALID');
  }
  return Object.freeze({ 'catering.configuration': value === 'true' });
}

export function cateringConfigurationEnabled(flags = FEATURE_FLAG_DEFAULTS) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(flags))) throw new TypeError('FEATURE_FLAGS_INVALID');
  const keys = Reflect.ownKeys(flags);
  if (keys.length !== 1 || keys[0] !== 'catering.configuration') throw new TypeError('FEATURE_FLAGS_INVALID');
  const property = Object.getOwnPropertyDescriptor(flags, 'catering.configuration');
  if (!property.enumerable || !Object.hasOwn(property, 'value') || typeof property.value !== 'boolean') {
    throw new TypeError('FEATURE_FLAGS_INVALID');
  }
  return property.value;
}

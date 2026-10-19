// Rollout is server-owned configuration; enabling a flag grants no role, object or workflow authority.
export const FEATURE_FLAG_DEFAULTS = Object.freeze({ 'catering.configuration': false, 'catering.orders': false });

export function loadFeatureFlags(env = {}) {
  const value = env.CATERING_CONFIGURATION_ENABLED;
  if (value !== undefined && !['true', 'false'].includes(value)) {
    throw new TypeError('CATERING_CONFIGURATION_ENABLED_INVALID');
  }
  const orders = env.CATERING_ORDERS_ENABLED;
  if (orders !== undefined && !['true','false'].includes(orders)) throw new TypeError('CATERING_ORDERS_ENABLED_INVALID');
  return Object.freeze({ 'catering.configuration': value === 'true', 'catering.orders': orders === 'true' });
}

function enabled(flags, name) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(flags))) throw new TypeError('FEATURE_FLAGS_INVALID');
  const keys = Reflect.ownKeys(flags);
  if (!keys.includes('catering.configuration') || keys.length > 2
    || keys.some((key) => !Object.hasOwn(FEATURE_FLAG_DEFAULTS, key))) throw new TypeError('FEATURE_FLAGS_INVALID');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(flags, key);
    if (!property.enumerable || !Object.hasOwn(property, 'value') || typeof property.value !== 'boolean') {
      throw new TypeError('FEATURE_FLAGS_INVALID');
    }
  }
  return Object.hasOwn(flags, name) && flags[name] === true;
}
export function cateringConfigurationEnabled(flags = FEATURE_FLAG_DEFAULTS) {
  return enabled(flags, 'catering.configuration');
}
export function cateringOrdersEnabled(flags = FEATURE_FLAG_DEFAULTS) {
  return enabled(flags, 'catering.orders');
}

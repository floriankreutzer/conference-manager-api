import { isSupportedCurrencyCode } from './money.js';

// Order/quote aggregates are not catalogue unit prices. Keep the existing
// normalizeMoney/MAX_PRICE_MINOR contract unchanged for every catalogue entry.
export function normalizeCateringOrderTotal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('CATERING_ORDER_TOTAL_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('amountMinor') || !keys.includes('currency') || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !property.enumerable || !Object.hasOwn(property, 'value');
  })) throw new TypeError('CATERING_ORDER_TOTAL_INVALID');
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || value.amountMinor >= Number.MAX_SAFE_INTEGER
    || !isSupportedCurrencyCode(value.currency)) throw new TypeError('CATERING_ORDER_TOTAL_INVALID');
  return Object.freeze({ amountMinor: value.amountMinor, currency: value.currency });
}

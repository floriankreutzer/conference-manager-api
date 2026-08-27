export const SUPPORTED_CURRENCY_CODES = Object.freeze(['CHF', 'EUR', 'GBP', 'USD']);
export const MAX_PRICE_MINOR = 1_000_000_000;

const SUPPORTED_CURRENCIES = new Set(SUPPORTED_CURRENCY_CODES);

export class MoneyValidationError extends Error {
  constructor(code = 'MONEY_INVALID') {
    super(code);
    this.name = 'MoneyValidationError';
    this.code = code;
  }
}

function invalid(code) {
  throw new MoneyValidationError(code);
}

export function isSupportedCurrencyCode(value) {
  return SUPPORTED_CURRENCIES.has(value);
}

export function normalizeMoney(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('MONEY_INVALID');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currency') {
    invalid('MONEY_INVALID');
  }
  if (
    !Number.isSafeInteger(value.amountMinor)
    || value.amountMinor < 0
    || value.amountMinor > MAX_PRICE_MINOR
  ) {
    invalid('MONEY_AMOUNT_INVALID');
  }
  if (!isSupportedCurrencyCode(value.currency)) invalid('MONEY_CURRENCY_INVALID');
  return Object.freeze({ amountMinor: value.amountMinor, currency: value.currency });
}

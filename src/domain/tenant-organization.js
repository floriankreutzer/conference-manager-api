import { isInternalUuid } from './identifiers.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const LOCALES = new Set(['de', 'en']);
const CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF']);
const ACCENTS = new Set(['graphite', 'bordeaux', 'camel']);

export class TenantOrganizationInputError extends Error {
  constructor(code = 'TENANT_ORGANIZATION_INVALID') {
    super(code);
    this.name = 'TenantOrganizationInputError';
    this.code = code;
  }
}

function invalid(code) {
  throw new TenantOrganizationInputError(code);
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('TENANT_ORGANIZATION_INVALID');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid('TENANT_ORGANIZATION_INVALID');
  }
  return value;
}

function boundedText(value, maximum, code) {
  if (typeof value !== 'string') invalid(code);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || CONTROL_CHARACTER.test(normalized)) invalid(code);
  return normalized;
}

export function normalizeTenantOrganization(value) {
  const input = exactObject(value, [
    'displayName',
    'defaultLocale',
    'currency',
    'accent',
    'logoAssetId',
  ]);
  if (!LOCALES.has(input.defaultLocale)) invalid('TENANT_DEFAULT_LOCALE_INVALID');
  if (!CURRENCIES.has(input.currency)) invalid('TENANT_CURRENCY_INVALID');
  if (!ACCENTS.has(input.accent)) invalid('TENANT_BRAND_ACCENT_INVALID');
  if (input.logoAssetId !== null && !isInternalUuid(input.logoAssetId)) {
    invalid('TENANT_BRAND_ASSET_ID_INVALID');
  }
  return Object.freeze({
    displayName: boundedText(input.displayName, 160, 'TENANT_ORGANIZATION_NAME_INVALID'),
    defaultLocale: input.defaultLocale,
    currency: input.currency,
    accent: input.accent,
    logoAssetId: input.logoAssetId,
  });
}

export function normalizeBrandAssetUpload(value) {
  const input = exactObject(value, ['mediaType', 'contentBase64']);
  if (input.mediaType !== 'image/png' && input.mediaType !== 'image/webp') {
    invalid('TENANT_BRAND_ASSET_TYPE_INVALID');
  }
  if (typeof input.contentBase64 !== 'string' || input.contentBase64.length < 4 || input.contentBase64.length > 700000) {
    invalid('TENANT_BRAND_ASSET_CONTENT_INVALID');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64) || input.contentBase64.length % 4 !== 0) {
    invalid('TENANT_BRAND_ASSET_CONTENT_INVALID');
  }
  const content = Buffer.from(input.contentBase64, 'base64');
  if (content.length < 1 || content.length > 524288 || content.toString('base64') !== input.contentBase64) {
    invalid('TENANT_BRAND_ASSET_CONTENT_INVALID');
  }
  const isPng = content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isWebp = content.length >= 12
    && content.subarray(0, 4).toString('ascii') === 'RIFF'
    && content.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((input.mediaType === 'image/png' && !isPng) || (input.mediaType === 'image/webp' && !isWebp)) {
    invalid('TENANT_BRAND_ASSET_CONTENT_INVALID');
  }
  return Object.freeze({ mediaType: input.mediaType, content });
}

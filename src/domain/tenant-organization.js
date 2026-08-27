import { SUPPORTED_CURRENCY_CODES, isSupportedCurrencyCode } from './money.js';

const UNSAFE_TEXT_CHARACTER = /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const MANAGED_BRAND_REFERENCE = /^managed-brand:[A-Za-z0-9_-]{22,128}$/;

export const TENANT_ORGANIZATION_LOCALES = Object.freeze(['de-DE', 'en-GB']);
export const TENANT_ORGANIZATION_CURRENCIES = SUPPORTED_CURRENCY_CODES;
export const TENANT_BRAND_ACCENT_TOKENS = Object.freeze(['default']);

const LOCALES = new Set(TENANT_ORGANIZATION_LOCALES);
const ACCENT_TOKENS = new Set(TENANT_BRAND_ACCENT_TOKENS);

export class TenantOrganizationValidationError extends Error {
  constructor(code = 'TENANT_ORGANIZATION_INVALID') {
    super(code);
    this.name = 'TenantOrganizationValidationError';
    this.code = code;
  }
}

function invalid(code) {
  throw new TenantOrganizationValidationError(code);
}

function requireExactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
  return value;
}

function normalizeText(value, { min = 1, max, nullable = false, code }) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || UNSAFE_TEXT_CHARACTER.test(value)) invalid(code);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < min || normalized.length > max) invalid(code);
  return normalized;
}

function normalizeBusinessMetadata(value) {
  requireExactObject(
    value,
    ['legalName', 'registrationNumber', 'countryCode'],
    'TENANT_ORGANIZATION_BUSINESS_METADATA_INVALID',
  );
  const countryCode = value.countryCode;
  if (countryCode !== null && (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode))) {
    invalid('TENANT_ORGANIZATION_COUNTRY_INVALID');
  }
  return Object.freeze({
    legalName: normalizeText(value.legalName, {
      max: 160,
      nullable: true,
      code: 'TENANT_ORGANIZATION_LEGAL_NAME_INVALID',
    }),
    registrationNumber: normalizeText(value.registrationNumber, {
      max: 80,
      nullable: true,
      code: 'TENANT_ORGANIZATION_REGISTRATION_INVALID',
    }),
    countryCode,
  });
}

function normalizePresentation(value) {
  requireExactObject(
    value,
    ['defaultLocale', 'defaultCurrency'],
    'TENANT_ORGANIZATION_PRESENTATION_INVALID',
  );
  if (!LOCALES.has(value.defaultLocale)) invalid('TENANT_ORGANIZATION_LOCALE_INVALID');
  if (!isSupportedCurrencyCode(value.defaultCurrency)) {
    invalid('TENANT_ORGANIZATION_CURRENCY_INVALID');
  }
  return Object.freeze({
    defaultLocale: value.defaultLocale,
    defaultCurrency: value.defaultCurrency,
  });
}

function normalizeBranding(value) {
  requireExactObject(
    value,
    ['logoAssetRef', 'accentToken'],
    'TENANT_ORGANIZATION_BRANDING_INVALID',
  );
  if (
    value.logoAssetRef !== null
    && (typeof value.logoAssetRef !== 'string' || !MANAGED_BRAND_REFERENCE.test(value.logoAssetRef))
  ) {
    invalid('TENANT_ORGANIZATION_LOGO_REFERENCE_INVALID');
  }
  if (!ACCENT_TOKENS.has(value.accentToken)) invalid('TENANT_ORGANIZATION_ACCENT_INVALID');
  return Object.freeze({
    logoAssetRef: value.logoAssetRef,
    accentToken: value.accentToken,
  });
}

export function normalizeTenantOrganization(value) {
  requireExactObject(
    value,
    ['displayName', 'businessMetadata', 'presentation', 'branding'],
    'TENANT_ORGANIZATION_INVALID',
  );
  return Object.freeze({
    displayName: normalizeText(value.displayName, {
      max: 160,
      code: 'TENANT_ORGANIZATION_DISPLAY_NAME_INVALID',
    }),
    businessMetadata: normalizeBusinessMetadata(value.businessMetadata),
    presentation: normalizePresentation(value.presentation),
    branding: normalizeBranding(value.branding),
  });
}

export function tenantOrganizationChangeSummary(previous, next) {
  const left = normalizeTenantOrganization(previous);
  const right = normalizeTenantOrganization(next);
  return Object.freeze({
    displayNameChanged: left.displayName !== right.displayName,
    businessMetadataChanged: JSON.stringify(left.businessMetadata) !== JSON.stringify(right.businessMetadata),
    localeChanged: left.presentation.defaultLocale !== right.presentation.defaultLocale,
    currencyChanged: left.presentation.defaultCurrency !== right.presentation.defaultCurrency,
    brandingChanged: JSON.stringify(left.branding) !== JSON.stringify(right.branding),
  });
}

import {
  approvedValue,
  boundedText,
  exactObject,
  nullableBoundedText,
  requireConfigurationSnapshot,
  safeIdentifier,
} from './protocol.js';

const LOCALES = new Set(['de', 'en']);
const CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF']);
const THEMES = new Set(['bordeaux', 'camel', 'graphite']);

export const DEFAULT_ORGANIZATION_CONFIGURATION = Object.freeze({
  organization: Object.freeze({
    displayName: '',
    defaultLocale: 'de',
    currency: 'EUR',
    theme: Object.freeze({ accent: 'bordeaux', logoAssetId: null }),
  }),
});

export function normalizeOrganizationConfiguration(value) {
  exactObject(value, ['organization']);
  const organization = exactObject(
    value.organization,
    ['displayName', 'defaultLocale', 'currency', 'theme'],
  );
  const theme = exactObject(organization.theme, ['accent', 'logoAssetId']);
  const logoAssetId = nullableBoundedText(theme.logoAssetId, {
    minimum: 1,
    maximum: 128,
    code: 'TENANT_BRAND_ASSET_ID_INVALID',
  });
  if (logoAssetId !== null) safeIdentifier(logoAssetId, 'TENANT_BRAND_ASSET_ID_INVALID');

  return requireConfigurationSnapshot({
    organization: {
      displayName: boundedText(organization.displayName, {
        minimum: 1,
        maximum: 160,
        code: 'TENANT_ORGANIZATION_NAME_INVALID',
      }),
      defaultLocale: approvedValue(
        organization.defaultLocale,
        LOCALES,
        'TENANT_DEFAULT_LOCALE_INVALID',
      ),
      currency: approvedValue(
        organization.currency,
        CURRENCIES,
        'TENANT_CURRENCY_INVALID',
      ),
      theme: {
        accent: approvedValue(theme.accent, THEMES, 'TENANT_THEME_INVALID'),
        logoAssetId,
      },
    },
  });
}

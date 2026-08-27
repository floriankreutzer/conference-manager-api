import { isInternalUuid } from '../domain/identifiers.js';

export const CODE_SHIPPED_MANAGED_BRAND_REFERENCE =
  'managed-brand:conference-manager-mark-v1';
export const DEFAULT_LOGO_PRESET = 'product-default';
export const MANAGED_LOGO_PRESET = 'conference-manager-mark';

const MANAGED_PRESETS = new Map([
  [CODE_SHIPPED_MANAGED_BRAND_REFERENCE, Object.freeze({
    logoPreset: MANAGED_LOGO_PRESET,
  })],
]);

export function createCodeShippedManagedBrandPolicy() {
  return Object.freeze({
    async authorizeTenantReference({ tenantId, reference } = {}) {
      return isInternalUuid(tenantId)
        && typeof reference === 'string'
        && MANAGED_PRESETS.has(reference);
    },

    async resolveTenantReference({ tenantId, reference } = {}) {
      if (!isInternalUuid(tenantId) || typeof reference !== 'string') return null;
      return MANAGED_PRESETS.get(reference) || null;
    },
  });
}

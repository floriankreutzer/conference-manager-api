import { AuthorizationDeniedError } from '../authorization/errors.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeTenantOrganization } from '../domain/tenant-organization.js';
import {
  DEFAULT_LOGO_PRESET,
  MANAGED_LOGO_PRESET,
} from './managed-brand-preset-policy.js';
import {
  TENANT_SETTINGS_SCHEMA_VERSION,
  requireTenantSettingsRevision,
} from './tenant-settings-revision.js';

const LOGO_PRESETS = new Set([DEFAULT_LOGO_PRESET, MANAGED_LOGO_PRESET]);
const FALLBACK_BRANDING = Object.freeze({
  logoPreset: DEFAULT_LOGO_PRESET,
  accentToken: 'default',
});

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new TypeError('TENANT_PRESENTATION_CORRELATION_INVALID');
}

async function resolveBranding({ managedBrandPolicy, tenantId, organization }) {
  const reference = organization.branding.logoAssetRef;
  if (reference === null) return FALLBACK_BRANDING;
  let resolved = null;
  try {
    resolved = await managedBrandPolicy.resolveTenantReference({ tenantId, reference });
  } catch {
    resolved = null;
  }
  if (
    !resolved
    || typeof resolved !== 'object'
    || Array.isArray(resolved)
    || Object.keys(resolved).length !== 1
    || !LOGO_PRESETS.has(resolved.logoPreset)
  ) {
    return FALLBACK_BRANDING;
  }
  return Object.freeze({
    logoPreset: resolved.logoPreset,
    accentToken: organization.branding.accentToken,
  });
}

export function createTenantPresentationService({
  repository,
  authorizationPolicy,
  auditService,
  managedBrandPolicy,
} = {}) {
  if (!repository || typeof repository.loadCurrent !== 'function') {
    throw new TypeError('TENANT_PRESENTATION_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.authorizeTenantApplicationRead !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.recordAuthorizationDenied !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (!managedBrandPolicy || typeof managedBrandPolicy.resolveTenantReference !== 'function') {
    throw new TypeError('MANAGED_BRAND_POLICY_REQUIRED');
  }

  return Object.freeze({
    async current({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      try {
        authorizationPolicy.authorizeTenantApplicationRead(principal, tenantContext);
      } catch (error) {
        if (
          error instanceof AuthorizationDeniedError
          && principal?.tenantId === tenantContext?.tenantId
          && isInternalUuid(principal?.userId)
        ) {
          await auditService.recordAuthorizationDenied({
            principal,
            tenantContext,
            correlationId,
            targetType: 'tenant_presentation',
            targetId: 'tenant-presentation',
            metadata: { operation: 'read' },
          });
        }
        throw error;
      }

      const result = await repository.loadCurrent(tenantContext.tenantId);
      if (!result) throw concealedNotFound();
      const organization = normalizeTenantOrganization(result.organization);
      return Object.freeze({
        schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
        revision: requireTenantSettingsRevision(result.revision),
        presentation: Object.freeze({
          displayName: organization.displayName,
          defaultLocale: organization.presentation.defaultLocale,
          defaultCurrency: organization.presentation.defaultCurrency,
          branding: await resolveBranding({
            managedBrandPolicy,
            tenantId: tenantContext.tenantId,
            organization,
          }),
        }),
      });
    },
  });
}

import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  TenantOrganizationValidationError,
  normalizeTenantOrganization,
  tenantOrganizationChangeSummary,
} from '../domain/tenant-organization.js';
import {
  TenantSettingsInputError,
  TenantSettingsConflictError,
} from './tenant-settings-errors.js';
import {
  TENANT_SETTINGS_SCHEMA_VERSION,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
} from './tenant-settings-revision.js';

function inputError(code = 'TENANT_ORGANIZATION_INPUT_INVALID') {
  return new TenantSettingsInputError(code);
}

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw inputError('TENANT_ORGANIZATION_CORRELATION_INVALID');
}

function requirePage({ limit = 25, beforeRevision = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw inputError('TENANT_ORGANIZATION_HISTORY_LIMIT_INVALID');
  }
  if (beforeRevision !== null) requireTenantSettingsRevision(beforeRevision);
  return Object.freeze({ limit, beforeRevision });
}

function normalize(value) {
  try {
    return normalizeTenantOrganization(value);
  } catch (error) {
    if (error instanceof TenantOrganizationValidationError) throw inputError(error.code);
    throw error;
  }
}

function publicCurrent(value) {
  if (!value || typeof value !== 'object') throw new TypeError('TENANT_ORGANIZATION_RESULT_INVALID');
  return Object.freeze({
    schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
    revision: requireTenantSettingsRevision(value.revision),
    organization: normalize(value.organization),
  });
}

export function createTenantOrganizationService({
  repository,
  authorizationPolicy,
  auditService,
  managedAssetPolicy = Object.freeze({
    async authorizeTenantReference({ reference }) {
      return reference === null;
    },
  }),
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.loadCurrent !== 'function'
    || typeof repository.listHistory !== 'function'
    || typeof repository.update !== 'function'
  ) {
    throw new TypeError('TENANT_ORGANIZATION_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (!managedAssetPolicy || typeof managedAssetPolicy.authorizeTenantReference !== 'function') {
    throw new TypeError('MANAGED_ASSET_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');

  async function authorize({ principal, tenantContext, correlationId, operation }) {
    try {
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_CONFIGURE,
      );
    } catch (error) {
      if (
        error instanceof AuthorizationDeniedError
        && principal?.tenantId === tenantContext?.tenantId
      ) {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: 'organization',
          targetId: 'tenant-organization',
          metadata: { operation },
        });
      }
      throw error;
    }
  }

  async function authorizeManagedAsset(tenantId, reference) {
    if (reference === null) return;
    let permitted = false;
    try {
      permitted = await managedAssetPolicy.authorizeTenantReference({ tenantId, reference });
    } catch {
      permitted = false;
    }
    if (permitted !== true) throw inputError('TENANT_ORGANIZATION_LOGO_REFERENCE_UNAVAILABLE');
  }

  return Object.freeze({
    async current({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'read' });
      const result = await repository.loadCurrent(tenantContext.tenantId);
      if (!result) throw concealedNotFound();
      return publicCurrent(result);
    },

    async history({
      principal,
      tenantContext,
      correlationId,
      limit = 25,
      beforeRevision = null,
    }) {
      requireCorrelationId(correlationId);
      const page = requirePage({ limit, beforeRevision });
      await authorize({ principal, tenantContext, correlationId, operation: 'history' });
      const rows = await repository.listHistory({
        tenantId: tenantContext.tenantId,
        ...page,
      });
      if (!Array.isArray(rows)) throw new TypeError('TENANT_ORGANIZATION_HISTORY_RESULT_INVALID');
      const revisions = rows.map((row) => Object.freeze({
        revision: requireTenantSettingsRevision(row.revision),
        effectiveAt: row.effectiveAt,
        organization: normalize(row.organization),
      }));
      return Object.freeze({
        schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
        revisions: Object.freeze(revisions),
        nextBeforeRevision: revisions.length === page.limit ? revisions.at(-1).revision : null,
      });
    },

    async update({
      principal,
      tenantContext,
      correlationId,
      schemaVersion,
      expectedRevision,
      organization,
    }) {
      requireCorrelationId(correlationId);
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const proposed = normalize(organization);
      await authorize({ principal, tenantContext, correlationId, operation: 'update' });
      await authorizeManagedAsset(tenantContext.tenantId, proposed.branding.logoAssetRef);

      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0) {
        throw new TypeError('TENANT_ORGANIZATION_CLOCK_INVALID');
      }
      const changedAt = new Date(changedMs);
      const result = await repository.update({
        tenantId: tenantContext.tenantId,
        actorUserId: principal.userId,
        expectedRevision: expected,
        organization: proposed,
        changedAt,
        correlationId,
        auditEventFor({ previous, next, nextRevision }) {
          const summary = tenantOrganizationChangeSummary(previous, next);
          return auditService.createEvent({
            principal,
            tenantContext,
            correlationId,
            action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
            targetType: 'organization',
            targetId: 'tenant-organization',
            previousState: { revision: expected },
            newState: { revision: nextRevision },
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { operation: 'update', ...summary },
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt: changedAt.toISOString(),
          });
        },
      });
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      if (result?.status === 'not_found') throw concealedNotFound();
      if (result?.status !== 'updated' || !result.current) {
        throw new TypeError('TENANT_ORGANIZATION_UPDATE_RESULT_INVALID');
      }
      return publicCurrent(result.current);
    },
  });
}

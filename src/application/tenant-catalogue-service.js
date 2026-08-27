import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  TenantCatalogueValidationError,
  normalizeTenantCatalogue,
  snapshotTenantCatalogueSelection,
  tenantCatalogueSummary,
} from '../domain/tenant-catalogue.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from './tenant-settings-errors.js';
import {
  TENANT_SETTINGS_SCHEMA_VERSION,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
} from './tenant-settings-revision.js';

function inputError(code = 'TENANT_CATALOGUE_INPUT_INVALID') {
  return new TenantSettingsInputError(code);
}

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw inputError(code);
  return value.toLowerCase();
}

function normalize(value) {
  try {
    return normalizeTenantCatalogue(value);
  } catch (error) {
    if (error instanceof TenantCatalogueValidationError) throw inputError(error.code);
    throw error;
  }
}

function publicCurrent(value) {
  if (!value || typeof value !== 'object') throw new TypeError('TENANT_CATALOGUE_RESULT_INVALID');
  return Object.freeze({
    schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
    revision: requireTenantSettingsRevision(value.revision),
    catalogue: normalize(value.catalogue),
  });
}

function page({ limit = 25, beforeRevision = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw inputError('TENANT_CATALOGUE_HISTORY_LIMIT_INVALID');
  }
  if (beforeRevision !== null) requireTenantSettingsRevision(beforeRevision);
  return Object.freeze({ limit, beforeRevision });
}

export function createTenantCatalogueService({
  repository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.loadCurrent !== 'function'
    || typeof repository.listHistory !== 'function'
    || typeof repository.replace !== 'function'
    || typeof repository.scopeExists !== 'function'
  ) {
    throw new TypeError('TENANT_CATALOGUE_REPOSITORY_REQUIRED');
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
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');

  function currentTime() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_CATALOGUE_CLOCK_INVALID');
    return new Date(value);
  }

  async function authorize({ principal, tenantContext, correlationId, operation }) {
    requireUuid(correlationId, 'TENANT_CATALOGUE_CORRELATION_INVALID');
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
          targetType: 'catalogue',
          targetId: 'tenant-catalogue',
          metadata: { operation },
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    async current({ principal, tenantContext, correlationId }) {
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
      const normalizedPage = page({ limit, beforeRevision });
      await authorize({ principal, tenantContext, correlationId, operation: 'history' });
      const rows = await repository.listHistory({
        tenantId: tenantContext.tenantId,
        ...normalizedPage,
      });
      if (!Array.isArray(rows)) throw new TypeError('TENANT_CATALOGUE_HISTORY_RESULT_INVALID');
      const revisions = rows.map((row) => Object.freeze({
        revision: requireTenantSettingsRevision(row.revision),
        effectiveAt: row.effectiveAt,
        catalogue: normalize(row.catalogue),
      }));
      return Object.freeze({
        schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
        revisions: Object.freeze(revisions),
        nextBeforeRevision: revisions.length === normalizedPage.limit
          ? revisions.at(-1).revision
          : null,
      });
    },

    async update({
      principal,
      tenantContext,
      correlationId,
      schemaVersion,
      expectedRevision,
      catalogue,
    }) {
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const proposed = normalize(catalogue);
      await authorize({ principal, tenantContext, correlationId, operation: 'update' });
      const changedAt = currentTime();
      const result = await repository.replace({
        tenantId: tenantContext.tenantId,
        actorUserId: principal.userId,
        correlationId,
        expectedRevision: expected,
        catalogue: proposed,
        changedAt,
        auditEventFor({ previous, next, nextRevision }) {
          return auditService.createEvent({
            principal,
            tenantContext,
            correlationId,
            action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
            targetType: 'catalogue',
            targetId: 'tenant-catalogue',
            previousState: { revision: expected },
            newState: { revision: nextRevision },
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { operation: 'update', ...tenantCatalogueSummary(next) },
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt: changedAt.toISOString(),
          });
        },
      });
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      if (result?.status === 'not_found') throw concealedNotFound();
      if (result?.status === 'reference_invalid') {
        throw inputError('TENANT_CATALOGUE_REFERENCE_INVALID');
      }
      if (result?.status === 'removal_forbidden') {
        throw inputError('TENANT_CATALOGUE_ARCHIVE_REQUIRED');
      }
      if (result?.status !== 'updated' || !result.current) {
        throw new TypeError('TENANT_CATALOGUE_UPDATE_RESULT_INVALID');
      }
      return publicCurrent(result.current);
    },

    async snapshotForRequest({ tenantId, siteId, roomId, selection }) {
      const trustedTenantId = requireUuid(tenantId, 'TENANT_CATALOGUE_TENANT_ID_INVALID');
      const trustedSiteId = typeof siteId === 'string' ? siteId : '';
      const trustedRoomId = typeof roomId === 'string' ? roomId : '';
      if (await repository.scopeExists({
        tenantId: trustedTenantId,
        siteId: trustedSiteId,
        roomId: trustedRoomId,
      }) !== true) {
        throw inputError('TENANT_CATALOGUE_SELECTION_UNAVAILABLE');
      }
      const current = await repository.loadCurrent(trustedTenantId);
      if (!current) throw concealedNotFound();
      try {
        return snapshotTenantCatalogueSelection({
          catalogue: current.catalogue,
          revision: current.revision,
          selection,
          siteId: trustedSiteId,
          roomId: trustedRoomId,
          capturedAt: currentTime().toISOString(),
        });
      } catch (error) {
        if (error instanceof TenantCatalogueValidationError) throw inputError(error.code);
        throw error;
      }
    },
  });
}

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
import { createTenantBulkTransferOperations } from './tenant-bulk-transfer-operations.js';

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
  bulkTransferRepository,
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
  const bulk = bulkTransferRepository ? createTenantBulkTransferOperations({
    aggregate: 'catalogue',
    bulkTransferRepository,
    clock,
  }) : null;

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

  let service;
  service = Object.freeze({
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
      bulkReceipt = null,
    }) {
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const proposed = normalize(catalogue);
      await authorize({ principal, tenantContext, correlationId, operation: 'update' });
      const changedAt = currentTime();
      let result;
      try {
        result = await repository.replace({
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
          bulkReceipt,
          bulkResponseFor: (value) => publicCurrent(value.current),
        });
      } catch (error) {
        if (['TENANT_BULK_RECEIPT_INVALID', 'TENANT_BULK_RECEIPT_EXPIRED'].includes(error?.code)) {
          throw inputError(error.code);
        }
        throw error;
      }
      if (result?.status === 'bulk_replay' || result?.status === 'bulk_applied') return result.response;
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

    async bulkTemplate({ principal, tenantContext, correlationId, type }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      await authorize({ principal, tenantContext, correlationId, operation: 'bulk_template' });
      return bulk.template(type);
    },

    async bulkExport({ principal, tenantContext, correlationId, type }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      await authorize({ principal, tenantContext, correlationId, operation: 'bulk_export' });
      const current = await repository.loadCurrent(tenantContext.tenantId);
      if (!current) throw concealedNotFound();
      return Object.freeze({
        revision: current.revision,
        document: bulk.export(type, current.catalogue),
      });
    },

    async bulkValidate({ principal, tenantContext, correlationId, type, document }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      await authorize({ principal, tenantContext, correlationId, operation: 'bulk_validate' });
      const current = await repository.loadCurrent(tenantContext.tenantId);
      if (!current) throw concealedNotFound();
      return bulk.validate({
        principal, tenantContext, correlationId, type, document,
        current: { revision: current.revision, configuration: current.catalogue },
        validateCandidate: (catalogue) => repository.validateCandidateReferences({
          tenantId: tenantContext.tenantId,
          catalogue,
        }),
      });
    },

    async bulkApply({ principal, tenantContext, correlationId, type, document, receiptId }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      await authorize({ principal, tenantContext, correlationId, operation: 'bulk_apply' });
      const current = await repository.loadCurrent(tenantContext.tenantId);
      if (!current) throw concealedNotFound();
      return bulk.apply({
        principal, tenantContext, type, document, receiptId,
        current: { revision: current.revision, configuration: current.catalogue },
        update: ({ expectedRevision, configuration, bulkReceipt }) => service.update({
          principal,
          tenantContext,
          correlationId,
          schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
          expectedRevision,
          catalogue: configuration,
          bulkReceipt,
        }),
      });
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
  return service;
}

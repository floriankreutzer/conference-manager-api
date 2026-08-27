import { createHash, randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  normalizeBrandAssetUpload,
  normalizeTenantOrganization,
} from '../domain/tenant-organization.js';
import {
  assertTenantSettingsRevision,
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
  TENANT_SETTINGS_SCHEMA_VERSION,
} from './tenant-settings-revision.js';

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}

function changedAt(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_ORGANIZATION_CLOCK_INVALID');
  return new Date(value);
}

function settingsAudit(auditService, {
  principal,
  tenantContext,
  correlationId,
  occurredAt,
  previousRevision,
  nextRevision,
}) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_configuration',
    targetId: 'organization',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'organization_update' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt: occurredAt.toISOString(),
  });
}

function assetAudit(auditService, {
  principal,
  tenantContext,
  correlationId,
  occurredAt,
  assetId,
  sizeBytes,
  mediaType,
}) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'brand_asset',
    targetId: assetId,
    previousState: null,
    newState: { created: true, sizeBytes, mediaType },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'brand_asset_upload' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt: occurredAt.toISOString(),
  });
}

export function createTenantOrganizationService({
  repository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.get !== 'function'
    || typeof repository.update !== 'function'
    || typeof repository.createBrandAsset !== 'function'
    || typeof repository.findBrandAsset !== 'function'
  ) throw new TypeError('TENANT_ORGANIZATION_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') throw new TypeError('AUDIT_SERVICE_REQUIRED');
  if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('TENANT_ORGANIZATION_RUNTIME_INVALID');

  function authorize(principal, tenantContext) {
    authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_CONFIGURE);
  }

  return Object.freeze({
    async get({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorize(principal, tenantContext);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_ORGANIZATION_NOT_FOUND');
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...current });
    },

    async update({ principal, tenantContext, correlationId, payload }) {
      requireCorrelationId(correlationId);
      authorize(principal, tenantContext);
      requireTenantSettingsSchemaVersion(payload?.schemaVersion);
      const expectedRevision = requireTenantSettingsRevision(payload?.expectedRevision);
      const organization = normalizeTenantOrganization(payload?.organization);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_ORGANIZATION_NOT_FOUND');
      assertTenantSettingsRevision(expectedRevision, current.revision);
      const nextRevision = nextTenantSettingsRevision(current.revision);
      const occurredAt = changedAt(clock);
      const result = await repository.update({
        tenantId: tenantContext.tenantId,
        expectedRevision,
        organization,
        changedAt: occurredAt,
        auditEvent: settingsAudit(auditService, {
          principal,
          tenantContext,
          correlationId,
          occurredAt,
          previousRevision: current.revision,
          nextRevision,
        }),
      });
      if (!result) throw new AuthorizationInputError('TENANT_ORGANIZATION_NOT_FOUND');
      if (result.conflict) assertTenantSettingsRevision(expectedRevision, result.currentRevision);
      if (result.missingLogoAsset) throw new AuthorizationInputError('TENANT_BRAND_ASSET_NOT_FOUND');
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...result });
    },

    async uploadBrandAsset({ principal, tenantContext, correlationId, payload }) {
      requireCorrelationId(correlationId);
      authorize(principal, tenantContext);
      const { mediaType, content } = normalizeBrandAssetUpload(payload);
      const assetId = idFactory();
      if (!isInternalUuid(assetId)) throw new TypeError('TENANT_BRAND_ASSET_ID_FACTORY_INVALID');
      const occurredAt = changedAt(clock);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const stored = await repository.createBrandAsset({
        tenantId: tenantContext.tenantId,
        assetId,
        actorUserId: principal.userId,
        mediaType,
        content,
        sha256,
        createdAt: occurredAt,
        auditEvent: assetAudit(auditService, {
          principal,
          tenantContext,
          correlationId,
          occurredAt,
          assetId,
          sizeBytes: content.length,
          mediaType,
        }),
      });
      if (!stored) throw new AuthorizationInputError('TENANT_BRAND_ASSET_UPLOAD_DENIED');
      return Object.freeze({
        id: stored.id,
        mediaType: stored.mediaType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      });
    },

    async getBrandAsset({ principal, tenantContext, correlationId, assetId }) {
      requireCorrelationId(correlationId);
      authorize(principal, tenantContext);
      if (!isInternalUuid(assetId)) throw new AuthorizationInputError('TENANT_BRAND_ASSET_ID_INVALID');
      const asset = await repository.findBrandAsset(tenantContext.tenantId, assetId);
      if (!asset) throw new AuthorizationInputError('TENANT_BRAND_ASSET_NOT_FOUND');
      return asset;
    },
  });
}

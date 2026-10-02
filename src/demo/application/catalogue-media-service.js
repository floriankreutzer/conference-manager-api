import { PERMISSION } from '../../authorization/policy.js';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../../audit/event.js';
import { processRoomImage } from '../../media/room-image-processor.js';

const OWNER_KIND = Object.freeze({
  'catering-item': 'catering_item',
  'catering-package': 'catering_package',
});

export function createDemoCatalogueMediaService({
  mediaRepository,
  authorizationPolicy,
  auditService,
} = {}) {
  if (!mediaRepository || typeof mediaRepository.create !== 'function'
    || typeof mediaRepository.remove !== 'function'
    || typeof mediaRepository.replace !== 'function'
    || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || typeof auditService?.createEvent !== 'function') {
    throw new TypeError('DEMO_CATALOGUE_MEDIA_SERVICE_INVALID');
  }

  const requireManager = (principal, tenant) => {
    authorizationPolicy.requireTenantPermission(
      principal, tenant, PERMISSION.TENANT_CATALOGUE_MANAGE,
    );
  };

  return Object.freeze({
    async replace({ principal, tenant, requestId, assetId, source }) {
      requireManager(principal, tenant);
      // Existing Demo room plans are PNG and keep that established replacement contract.
      // Catering assets are WebP; only non-WebP Catering sources need sanitizing/re-encoding.
      const processed = source.contentType === 'image/png'
        ? source
        : await processRoomImage(source);
      return mediaRepository.replace({
        tenantId: tenant.tenantId,
        assetId,
        actorUserId: principal.userId,
        ...processed,
        auditEvent: ({ sha256, byteLength, contentType }) => auditService.createEvent({
          principal,
          tenantContext: tenant,
          correlationId: requestId,
          action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'demo_catalogue_media',
          targetId: assetId,
          newState: { sha256, byteLength, contentType },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: { operation: 'replace' },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        }),
      });
    },

    async create({ principal, tenant, requestId, ownerType, ownerId, source }) {
      requireManager(principal, tenant);
      const ownerKind = OWNER_KIND[ownerType];
      if (!ownerKind) throw new TypeError('DEMO_MEDIA_OWNER_INVALID');
      const processed = await processRoomImage(source);
      return mediaRepository.create({
        tenantId: tenant.tenantId,
        ownerKind,
        ownerId,
        actorUserId: principal.userId,
        ...processed,
        altText: ownerId,
        auditEvent: ({ assetId, sha256, byteLength, contentType }) => auditService.createEvent({
          principal,
          tenantContext: tenant,
          correlationId: requestId,
          action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'demo_catalogue_media',
          targetId: assetId,
          newState: { sha256, byteLength, contentType },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: { operation: 'create', ownerKind },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        }),
      });
    },

    async remove({ principal, tenant, requestId, assetId }) {
      requireManager(principal, tenant);
      return mediaRepository.remove({
        tenantId: tenant.tenantId,
        assetId,
        actorUserId: principal.userId,
        auditEvent: ({ ownerKind }) => auditService.createEvent({
          principal,
          tenantContext: tenant,
          correlationId: requestId,
          action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'demo_catalogue_media',
          targetId: assetId,
          newState: { removed: true },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: { operation: 'remove', ownerKind },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        }),
      });
    },
  });
}

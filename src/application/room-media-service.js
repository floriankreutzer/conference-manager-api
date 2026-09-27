import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { processRoomImage } from '../media/room-image-processor.js';

export function createRoomMediaService({ repository, authorizationPolicy, auditService } = {}) {
  if (!repository?.create || !repository?.findAttached
    || !authorizationPolicy?.requireTenantPermission || !auditService?.createEvent) {
    throw new TypeError('ROOM_MEDIA_SERVICE_DEPENDENCIES_REQUIRED');
  }

  return Object.freeze({
    async upload({ principal, tenantContext, correlationId, roomId, bytes, contentType }) {
      authorizationPolicy.requireTenantPermission(
        principal, tenantContext, PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
      );
      const image = await processRoomImage({ bytes, contentType });
      return repository.create({
        tenantId: tenantContext.tenantId,
        roomId,
        actorUserId: principal.userId,
        image,
        auditEvent: (assetId) => auditService.createEvent({
          principal, tenantContext, correlationId,
          action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'tenant_room_media', targetId: assetId,
          newState: { roomId, byteLength: image.bytes.length },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: { operation: 'upload', format: 'webp' },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        }),
      });
    },

    async read({ principal, tenantContext, roomId, assetId }) {
      let includeInactive = false;
      try {
        authorizationPolicy.requireTenantPermission(
          principal, tenantContext, PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
        );
        includeInactive = true;
      } catch (error) {
        if (!(error instanceof AuthorizationDeniedError)) throw error;
        authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.REQUEST_READ);
      }
      return repository.findAttached({ tenantId: tenantContext.tenantId, roomId, assetId, includeInactive });
    },
  });
}

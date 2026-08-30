import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../../audit/event.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_RETENTION,
} from '../../platform/audit/event.js';
import { PLATFORM_OPERATION } from '../../platform/application/platform-operation-contract.js';

const PLATFORM_ACTION_BY_OPERATION = new Map([
  [PLATFORM_OPERATION.TENANT_INVITATION_CREATE, PLATFORM_AUDIT_ACTION.TENANT_REGISTRATION_CHANGED],
  [PLATFORM_OPERATION.INVITATION_REVOKE, PLATFORM_AUDIT_ACTION.TENANT_INVITATION_CHANGED],
  [PLATFORM_OPERATION.INVITATION_REISSUE, PLATFORM_AUDIT_ACTION.TENANT_INVITATION_CHANGED],
  [PLATFORM_OPERATION.LIFECYCLE_TRANSITION, PLATFORM_AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED],
  [PLATFORM_OPERATION.ENTITLEMENT_APPLY, PLATFORM_AUDIT_ACTION.TENANT_ENTITLEMENT_CHANGED],
  [PLATFORM_OPERATION.DIAGNOSTIC_SUMMARY_READ, PLATFORM_AUDIT_ACTION.DIAGNOSTICS_READ],
  [PLATFORM_OPERATION.DIAGNOSTIC_CORRELATION_READ, PLATFORM_AUDIT_ACTION.DIAGNOSTICS_READ],
]);

const RECOVERY_OPERATIONS = new Set([
  PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN,
  PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT,
  PLATFORM_OPERATION.REPAIR_ROOM_MAPPING,
  PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY,
  PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS,
  PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
  PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT,
  PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT,
]);

const TENANT_ACTION_BY_OPERATION = new Map([
  [PLATFORM_OPERATION.TENANT_INVITATION_CREATE, AUDIT_ACTION.TENANT_ONBOARDING_INVITED],
  [PLATFORM_OPERATION.INVITATION_REVOKE, AUDIT_ACTION.TENANT_ONBOARDING_INVITED],
  [PLATFORM_OPERATION.INVITATION_REISSUE, AUDIT_ACTION.TENANT_ONBOARDING_INVITED],
  [PLATFORM_OPERATION.LIFECYCLE_TRANSITION, AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED],
  [PLATFORM_OPERATION.ENTITLEMENT_APPLY, AUDIT_ACTION.TENANT_ENTITLEMENT_CHANGED],
  [PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN, AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED],
  [PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT, AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED],
  [PLATFORM_OPERATION.REPAIR_ROOM_MAPPING, AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED],
  [PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY, AUDIT_ACTION.TENANT_IDENTITY_UNBOUND],
  [PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS, AUDIT_ACTION.SESSION_REVOKED],
  [PLATFORM_OPERATION.REVOKE_USER_SESSIONS, AUDIT_ACTION.SESSION_REVOKED],
  [PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT, AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED],
  [PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT, AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED],
]);

function exact(value, keys, code) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) throw new TypeError(code);
  return value;
}

function scalarState(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PLATFORM_OPERATION_EVIDENCE_STATE_INVALID');
  }
  const projected = {};
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (Object.keys(projected).length >= 16) break;
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
      projected[key] = entry;
    } else if (Array.isArray(entry)) {
      projected[`${key}Count`] = entry.length;
    }
  }
  return Object.freeze(projected);
}

function mutationActions(operation) {
  const platformAction = RECOVERY_OPERATIONS.has(operation)
    ? PLATFORM_AUDIT_ACTION.RECOVERY_EXECUTED
    : PLATFORM_ACTION_BY_OPERATION.get(operation);
  const tenantAction = TENANT_ACTION_BY_OPERATION.get(operation);
  if (!platformAction || !tenantAction) throw new TypeError('PLATFORM_OPERATION_EVIDENCE_OPERATION_INVALID');
  return Object.freeze({ platformAction, tenantAction });
}

function retentionFor(operation) {
  return RECOVERY_OPERATIONS.has(operation)
    ? Object.freeze({
      platform: PLATFORM_AUDIT_RETENTION.RECOVERY,
      tenant: AUDIT_RETENTION_CLASS.SECURITY,
    })
    : Object.freeze({
      platform: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE,
      tenant: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    });
}

export function createPlatformOperationEvidenceFactory({
  tenantAuditService,
  platformAuditService,
} = {}) {
  if (!tenantAuditService || typeof tenantAuditService.createActorEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (
    !platformAuditService
    || typeof platformAuditService.createEvent !== 'function'
    || typeof platformAuditService.createDeniedEvent !== 'function'
  ) throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');

  return Object.freeze({
    async createMutation(values) {
      exact(values, [
        'authorization',
        'operation',
        'tenantId',
        'correlationId',
        'reason',
        'target',
        'previousState',
        'requestedState',
        'occurredAt',
      ], 'PLATFORM_OPERATION_EVIDENCE_INPUT_INVALID');
      const target = exact(values.target, ['type', 'id'], 'PLATFORM_OPERATION_EVIDENCE_TARGET_INVALID');
      const actions = mutationActions(values.operation);
      const retention = retentionFor(values.operation);
      const previousState = scalarState(values.previousState);
      const newState = scalarState(values.requestedState);
      const tenantAuditEvent = tenantAuditService.createActorEvent({
        tenantId: values.tenantId,
        actorUserId: null,
        action: actions.tenantAction,
        targetType: target.type,
        targetId: target.id,
        previousState,
        newState,
        occurredAt: values.occurredAt,
        correlationId: values.correlationId,
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { actorType: 'platform_operator', operation: values.operation, reasonRecorded: true },
        retentionClass: retention.tenant,
      });
      const platformAuditEvent = platformAuditService.createEvent({
        principal: values.authorization.principal,
        action: actions.platformAction,
        targetType: target.type,
        targetId: target.id,
        targetTenantId: values.tenantId,
        previousState,
        newState,
        correlationId: values.correlationId,
        metadata: { operation: values.operation, reasonRecorded: true },
        retentionClass: retention.platform,
      });
      return Object.freeze({ tenantAuditEvent, platformAuditEvent });
    },

    async createSensitiveRead(values) {
      exact(values, [
        'authorization',
        'operation',
        'tenantId',
        'correlationId',
        'target',
        'occurredAt',
      ], 'PLATFORM_OPERATION_EVIDENCE_INPUT_INVALID');
      const target = exact(values.target, ['type', 'id'], 'PLATFORM_OPERATION_EVIDENCE_TARGET_INVALID');
      const recovery = RECOVERY_OPERATIONS.has(values.operation);
      const action = recovery
        ? PLATFORM_AUDIT_ACTION.RECOVERY_PREVIEWED
        : PLATFORM_ACTION_BY_OPERATION.get(values.operation);
      if (!action) throw new TypeError('PLATFORM_OPERATION_EVIDENCE_OPERATION_INVALID');
      return Object.freeze({
        platformAuditEvent: platformAuditService.createEvent({
          principal: values.authorization.principal,
          action,
          targetType: target.type,
          targetId: target.id,
          targetTenantId: values.tenantId,
          correlationId: values.correlationId,
          metadata: { operation: values.operation, phase: recovery ? 'preview' : 'read' },
          retentionClass: recovery
            ? PLATFORM_AUDIT_RETENTION.RECOVERY
            : PLATFORM_AUDIT_RETENTION.SECURITY,
        }),
      });
    },

    createDenied({ principal, operation, tenantId, targetType, targetId, correlationId, reasonCode }) {
      return platformAuditService.createDeniedEvent({
        principal,
        action: PLATFORM_AUDIT_ACTION.AUTHORIZATION_DENIED,
        targetType,
        targetId,
        targetTenantId: tenantId,
        correlationId,
        metadata: { operation, reasonCode },
        retentionClass: PLATFORM_AUDIT_RETENTION.SECURITY,
      });
    },
  });
}


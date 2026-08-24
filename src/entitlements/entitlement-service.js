import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  ROLLOUT_STATE,
  evaluateEffectiveCapability,
  isKnownCapability,
  isRolloutState,
  normalizeCapabilityId,
} from './capabilities.js';
import { EntitlementDeniedError, EntitlementInputError } from './errors.js';

const DEFAULT_ROLLOUT_POLICY = Object.freeze({
  stateFor() {
    return ROLLOUT_STATE.NOT_CONTROLLED;
  },
});

function hasActiveTenantBinding(principal, tenantContext) {
  return Boolean(
    principal
    && tenantContext
    && isInternalUuid(principal.tenantId)
    && principal.tenantId === tenantContext.tenantId
    && tenantContext.status === 'active',
  );
}

export function createEntitlementService({
  repository,
  auditService,
  authorizeOperator = async () => false,
  rolloutPolicy = DEFAULT_ROLLOUT_POLICY,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.findByTenantIdAndCapabilityId !== 'function'
    || typeof repository.changeByTenantIdAndCapabilityId !== 'function'
  ) {
    throw new TypeError('ENTITLEMENT_REPOSITORY_REQUIRED');
  }
  if (!auditService || typeof auditService.createActorEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof authorizeOperator !== 'function') throw new TypeError('OPERATOR_AUTHORIZATION_REQUIRED');
  if (!rolloutPolicy || typeof rolloutPolicy.stateFor !== 'function') {
    throw new TypeError('ROLLOUT_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('ENTITLEMENT_CLOCK_REQUIRED');

  async function evaluateAccess({ principal, tenantContext, capabilityId, authorized }) {
    if (!isKnownCapability(capabilityId) || authorized !== true || !hasActiveTenantBinding(principal, tenantContext)) {
      return false;
    }
    const entitlement = await repository.findByTenantIdAndCapabilityId(tenantContext.tenantId, capabilityId);
    let rolloutState;
    try {
      rolloutState = rolloutPolicy.stateFor(capabilityId);
    } catch {
      return false;
    }
    if (!isRolloutState(rolloutState)) return false;
    return evaluateEffectiveCapability({
      authorized,
      entitled: entitlement?.enabled === true,
      rolloutState,
    });
  }

  return Object.freeze({
    evaluateAccess,

    async requireAccess(values) {
      if (await evaluateAccess(values)) return true;
      throw new EntitlementDeniedError();
    },

    async setEntitlement({ operatorContext, tenantId, capabilityId, enabled, correlationId }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(correlationId) || typeof enabled !== 'boolean') {
        throw new EntitlementInputError();
      }
      const normalizedCapabilityId = normalizeCapabilityId(capabilityId);
      if (await authorizeOperator(operatorContext, {
        tenantId,
        capabilityId: normalizedCapabilityId,
        enabled,
      }) !== true) {
        throw new EntitlementDeniedError('OPERATOR_NOT_AUTHORIZED');
      }
      const changedAtMs = clock();
      if (!Number.isSafeInteger(changedAtMs) || changedAtMs < 0) {
        throw new EntitlementInputError('ENTITLEMENT_CLOCK_INVALID');
      }
      const changedAt = new Date(changedAtMs);
      const occurredAt = changedAt.toISOString();

      const changed = await repository.changeByTenantIdAndCapabilityId({
        tenantId,
        capabilityId: normalizedCapabilityId,
        enabled,
        changedAt,
        auditEventForPrevious(previousEnabled) {
          return auditService.createActorEvent({
            tenantId,
            actorUserId: null,
            correlationId,
            action: AUDIT_ACTION.TENANT_ENTITLEMENT_CHANGED,
            targetType: 'entitlement',
            targetId: normalizedCapabilityId,
            previousState: { enabled: previousEnabled },
            newState: { enabled },
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { actorType: 'platform_operator' },
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt,
          });
        },
      });
      if (!changed) throw new EntitlementInputError('TENANT_NOT_FOUND');
      return changed;
    },
  });
}

import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  isTenantLifecycleTransitionAllowed,
} from '../tenancy/tenant-lifecycle-policy.js';
import { TENANT_ACTIVATION_CAPABILITIES } from '../tenancy/tenant-readiness-policy.js';
import { TenantPilotLifecycleConflictError } from './tenant-pilot-errors.js';

const REQUIRED_ENTITLEMENTS = TENANT_ACTIVATION_CAPABILITIES;
const OPTIONAL_ENTITLEMENTS = Object.freeze([
  'microsoft.calendar.write',
]);
const LIFECYCLE_TARGETS = new Set(['ready', 'active', 'suspended']);

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new TypeError('PILOT_CORRELATION_INVALID');
}

function activeBinding(value) {
  return Boolean(value && value.status === 'active');
}

function connected(value) {
  return Boolean(value && value.status === 'connected');
}

function healthy(value) {
  return Boolean(value && value.status === 'healthy' && typeof value.lastSuccessAt === 'string');
}

function entitled(value) {
  return value?.enabled === true;
}

export function createTenantPilotService({
  tenantRepository,
  bindingRepository,
  connectionRepository,
  roomMappingRepository,
  capabilityHealthRepository,
  entitlementRepository,
  authorizationPolicy,
  auditService,
  authorizeOperator = async () => false,
  clock = () => Date.now(),
} = {}) {
  const required = [
    [tenantRepository, 'findById'],
    [tenantRepository, 'changeStatus'],
    [tenantRepository, 'changeStatusIfReady'],
    [bindingRepository, 'findActiveBindingByTenantId'],
    [connectionRepository, 'findByTenantId'],
    [roomMappingRepository, 'listByTenantIdAndIntegrationId'],
    [capabilityHealthRepository, 'listByTenantIdAndIntegrationId'],
    [entitlementRepository, 'findByTenantIdAndCapabilityId'],
  ];
  if (required.some(([target, method]) => !target || typeof target[method] !== 'function')) {
    throw new TypeError('TENANT_PILOT_REPOSITORIES_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createActorEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof authorizeOperator !== 'function') throw new TypeError('OPERATOR_AUTHORIZATION_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('PILOT_CLOCK_REQUIRED');

  async function readinessForTenant(tenantId) {
    if (!isInternalUuid(tenantId)) throw new TypeError('TENANT_ID_INVALID');
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) return null;
    const binding = await bindingRepository.findActiveBindingByTenantId(tenantId, 'microsoft_entra');
    const connection = await connectionRepository.findByTenantId(tenantId);
    const integrationId = connection?.integrationId;
    const values = integrationId
      ? await Promise.all([
        roomMappingRepository.listByTenantIdAndIntegrationId(tenantId, integrationId),
        capabilityHealthRepository.listByTenantIdAndIntegrationId(tenantId, integrationId),
        entitlementRepository.findByTenantIdAndCapabilityId(tenantId, REQUIRED_ENTITLEMENTS[0]),
        entitlementRepository.findByTenantIdAndCapabilityId(tenantId, REQUIRED_ENTITLEMENTS[1]),
        entitlementRepository.findByTenantIdAndCapabilityId(tenantId, OPTIONAL_ENTITLEMENTS[0]),
      ])
      : [[], [], null, null, null];
    const [mappings, healthEntries, directoryEntitlement, calendarEntitlement, calendarWriteEntitlement] = values;
    const healthByCapability = new Map(healthEntries.map((entry) => [entry.capability, entry]));
    const checks = Object.freeze({
      tenantIdentityClaimed: activeBinding(binding),
      microsoft365Connected: connected(connection),
      placesPermissionGranted: connection?.placesPermission === 'granted',
      calendarPermissionGranted: connection?.calendarsPermission === 'granted',
      roomImported: mappings.some((mapping) => mapping.providerStatus === 'active'),
      freeBusyVerified: healthy(healthByCapability.get('free_busy')),
      directoryEntitled: entitled(directoryEntitlement),
      calendarEntitled: entitled(calendarEntitlement),
    });
    return Object.freeze({
      tenantStatus: tenant.status,
      ready: Object.values(checks).every(Boolean),
      checks,
      entitlements: Object.freeze({
        microsoftDirectory: entitled(directoryEntitlement),
        microsoftCalendar: entitled(calendarEntitlement),
        microsoftCalendarWrite: entitled(calendarWriteEntitlement),
      }),
    });
  }

  return Object.freeze({
    async getReadiness({ principal, tenantContext }) {
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_INTEGRATIONS_MANAGE,
      );
      return readinessForTenant(tenantContext.tenantId);
    },

    readinessForTenant,

    async setLifecycle({ operatorContext, tenantId, targetStatus, correlationId }) {
      if (!isInternalUuid(tenantId) || !LIFECYCLE_TARGETS.has(targetStatus)) {
        throw new TypeError('TENANT_PILOT_LIFECYCLE_INVALID');
      }
      requireCorrelationId(correlationId);
      if (await authorizeOperator(operatorContext, { tenantId, targetStatus }) !== true) {
        throw new TypeError('OPERATOR_NOT_AUTHORIZED');
      }
      const current = await tenantRepository.findById(tenantId);
      if (!current) throw new TypeError('TENANT_NOT_FOUND');
      if (current.status === targetStatus) return current;
      if (!isTenantLifecycleTransitionAllowed({ currentStatus: current.status, targetStatus })) {
        throw new TenantPilotLifecycleConflictError();
      }
      const changedAtMs = clock();
      if (!Number.isSafeInteger(changedAtMs) || changedAtMs < 0) throw new TypeError('PILOT_CLOCK_INVALID');
      const changedAt = new Date(changedAtMs);
      const auditEvent = auditService.createActorEvent({
        tenantId,
        actorUserId: null,
        correlationId,
        action: AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED,
        targetType: 'tenant',
        targetId: tenantId,
        previousState: { status: current.status },
        newState: { status: targetStatus },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { actorType: 'platform_operator' },
        retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        occurredAt: changedAt.toISOString(),
      });
      const input = {
        tenantId,
        expectedStatus: current.status,
        targetStatus,
        changedAt,
        auditEvent,
      };
      let changed;
      if (targetStatus === 'ready' || targetStatus === 'active') {
        const result = await tenantRepository.changeStatusIfReady(input);
        if (result?.outcome === 'not_ready') throw new TypeError('TENANT_PILOT_NOT_READY');
        changed = result?.outcome === 'updated' ? result.tenant : null;
      } else {
        changed = await tenantRepository.changeStatus(input);
      }
      if (!changed) throw new TenantPilotLifecycleConflictError();
      if (changed.id !== tenantId || changed.status !== targetStatus) {
        throw new TypeError('TENANT_PILOT_LIFECYCLE_RESULT_INVALID');
      }
      return changed;
    },
  });
}

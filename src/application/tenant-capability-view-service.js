import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { ROLLOUT_STATE, isRolloutState } from '../entitlements/capabilities.js';

export const TENANT_CAPABILITY_STATE = Object.freeze({
  OPERATIONAL: 'operational',
  BLOCKED: 'blocked',
  DEGRADED: 'degraded',
  NOT_ENTITLED: 'not_entitled',
  UNAVAILABLE: 'unavailable',
});

export const TENANT_CAPABILITY_AVAILABILITY = Object.freeze({
  INCLUDED: 'included',
  OPTIONAL: 'optional',
});

const CAPABILITY_ID = Object.freeze({
  USER_ADMINISTRATION: 'tenant.user_administration',
  AUDIT_HISTORY: 'tenant.audit_history',
  CONFIGURATION: 'tenant.configuration',
  MICROSOFT_DIRECTORY: 'microsoft.directory',
  MICROSOFT_CALENDAR: 'microsoft.calendar',
  MICROSOFT_CALENDAR_WRITE: 'microsoft.calendar.write',
});
const MICROSOFT_CAPABILITIES = new Set([
  CAPABILITY_ID.MICROSOFT_DIRECTORY,
  CAPABILITY_ID.MICROSOFT_CALENDAR,
  CAPABILITY_ID.MICROSOFT_CALENDAR_WRITE,
]);
const HEALTH_STATES = new Set([
  'healthy',
  'degraded',
  'unavailable',
  'revoked',
  'permission_missing',
  'not_configured',
]);
const ACTIVE_TENANT_STATUS = 'active';
const KNOWN_TENANT_STATUSES = new Set([
  'pending',
  'onboarding',
  'ready',
  'active',
  'suspended',
  'archived',
]);
const MAX_READINESS_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ROLLOUT_POLICY = Object.freeze({
  stateFor() {
    return ROLLOUT_STATE.NOT_CONTROLLED;
  },
});
const MICROSOFT_ACTION = Object.freeze({
  id: 'manage_microsoft_connection',
  href: '/settings/integrations/microsoft365',
});

function fixedCapability({
  id,
  availability,
  state,
  reasonCodes = [],
  action = null,
  lastCheckedAt = null,
}) {
  return Object.freeze({
    id,
    availability,
    state,
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    action,
    lastCheckedAt,
  });
}

function unavailable(id, availability, reasonCode) {
  return fixedCapability({
    id,
    availability,
    state: TENANT_CAPABILITY_STATE.UNAVAILABLE,
    reasonCodes: [reasonCode],
  });
}

function canonicalInstant(value) {
  return typeof value === 'string'
    && value.endsWith('Z')
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function capabilityAuthorized(authorizationPolicy, principal, tenantContext, permission) {
  try {
    authorizationPolicy.requireTenantPermission(principal, tenantContext, permission);
    return true;
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) return false;
    throw error;
  }
}

function rolloutState(rolloutPolicy, capabilityId) {
  try {
    const state = rolloutPolicy.stateFor(capabilityId);
    return isRolloutState(state) ? state : null;
  } catch {
    return null;
  }
}

function baseCapability({ id, availability, authorized, tenantActive, rollout }) {
  if (!tenantActive) return unavailable(id, availability, 'tenant_not_active');
  if (!authorized) return unavailable(id, availability, 'authority_missing');
  if (rollout === null) return unavailable(id, availability, 'rollout_state_unknown');
  if (rollout === ROLLOUT_STATE.DISABLED) return unavailable(id, availability, 'rollout_disabled');
  return fixedCapability({
    id,
    availability,
    state: TENANT_CAPABILITY_STATE.OPERATIONAL,
  });
}

function healthResult({ id, availability, health, clockValue }) {
  if (!health || !HEALTH_STATES.has(health.status)) {
    return unavailable(id, availability, 'provider_health_unknown');
  }
  const lastCheckedAt = canonicalInstant(health.lastCheckedAt) ? health.lastCheckedAt : null;
  if (health.status === 'healthy') {
    if (lastCheckedAt === null) {
      return fixedCapability({
        id,
        availability,
        state: TENANT_CAPABILITY_STATE.BLOCKED,
        reasonCodes: ['verification_required'],
        action: MICROSOFT_ACTION,
      });
    }
    const ageMs = clockValue - Date.parse(lastCheckedAt);
    if (ageMs < -5 * 60 * 1_000) {
      return unavailable(id, availability, 'provider_health_unknown');
    }
    if (ageMs > MAX_READINESS_AGE_MS) {
      return fixedCapability({
        id,
        availability,
        state: TENANT_CAPABILITY_STATE.DEGRADED,
        reasonCodes: ['readiness_stale'],
        action: MICROSOFT_ACTION,
        lastCheckedAt,
      });
    }
    return fixedCapability({
      id,
      availability,
      state: TENANT_CAPABILITY_STATE.OPERATIONAL,
      lastCheckedAt,
    });
  }
  const mapping = Object.freeze({
    degraded: Object.freeze({ state: TENANT_CAPABILITY_STATE.DEGRADED, reason: 'provider_degraded' }),
    unavailable: Object.freeze({ state: TENANT_CAPABILITY_STATE.DEGRADED, reason: 'provider_unavailable' }),
    revoked: Object.freeze({ state: TENANT_CAPABILITY_STATE.BLOCKED, reason: 'microsoft_reconnect_required' }),
    permission_missing: Object.freeze({ state: TENANT_CAPABILITY_STATE.BLOCKED, reason: 'provider_permission_required' }),
    not_configured: Object.freeze({ state: TENANT_CAPABILITY_STATE.BLOCKED, reason: 'verification_required' }),
  });
  const result = mapping[health.status];
  return fixedCapability({
    id,
    availability,
    state: result.state,
    reasonCodes: [result.reason],
    action: MICROSOFT_ACTION,
    lastCheckedAt,
  });
}

function check(value, key) {
  return value?.checks?.[key] === true;
}

function entitled(value, key) {
  return value?.entitlements?.[key] === true;
}

function microsoftCapability({
  id,
  availability,
  authorized,
  tenantActive,
  rollout,
  isEntitled,
  readiness,
  connection,
  health,
  requiredChecks,
  clockValue,
}) {
  if (!tenantActive) return unavailable(id, availability, 'tenant_not_active');
  if (!authorized) return unavailable(id, availability, 'authority_missing');
  if (rollout === null) return unavailable(id, availability, 'rollout_state_unknown');
  if (rollout === ROLLOUT_STATE.DISABLED) return unavailable(id, availability, 'rollout_disabled');
  if (!readiness || !connection) return unavailable(id, availability, 'readiness_unknown');
  if (!isEntitled) {
    return fixedCapability({
      id,
      availability,
      state: TENANT_CAPABILITY_STATE.NOT_ENTITLED,
      reasonCodes: ['entitlement_missing'],
    });
  }
  const missing = requiredChecks.find(({ key }) => !check(readiness, key));
  if (missing) {
    return fixedCapability({
      id,
      availability,
      state: TENANT_CAPABILITY_STATE.BLOCKED,
      reasonCodes: [missing.reason],
      action: MICROSOFT_ACTION,
    });
  }
  return healthResult({ id, availability, health, clockValue });
}

export function createTenantCapabilityViewService({
  authorizationPolicy,
  auditService,
  readinessService,
  microsoft365Service,
  rolloutPolicy = DEFAULT_ROLLOUT_POLICY,
  clock = () => Date.now(),
} = {}) {
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.recordAuthorizationDenied !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (!readinessService || typeof readinessService.getReadiness !== 'function') {
    throw new TypeError('TENANT_READINESS_SERVICE_REQUIRED');
  }
  if (!microsoft365Service || typeof microsoft365Service.getConnection !== 'function') {
    throw new TypeError('MICROSOFT365_SERVICE_REQUIRED');
  }
  if (!rolloutPolicy || typeof rolloutPolicy.stateFor !== 'function') {
    throw new TypeError('ROLLOUT_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CAPABILITY_CLOCK_REQUIRED');

  return Object.freeze({
    async getView({ principal, tenantContext, correlationId }) {
      if (!isInternalUuid(correlationId)) throw new TypeError('CAPABILITY_CORRELATION_INVALID');
      try {
        authorizationPolicy.requireTenantPermission(
          principal,
          tenantContext,
          PERMISSION.TENANT_CONFIGURE,
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await auditService.recordAuthorizationDenied({
            principal,
            tenantContext,
            correlationId,
            targetType: 'endpoint',
            targetId: 'tenant_capabilities',
            metadata: { operation: 'read' },
          });
        }
        throw error;
      }
      const clockValue = clock();
      if (!Number.isSafeInteger(clockValue) || clockValue < 0) {
        throw new TypeError('CAPABILITY_CLOCK_INVALID');
      }
      const tenantStatus = tenantContext?.status;
      const tenantKnown = KNOWN_TENANT_STATUSES.has(tenantStatus);
      const tenantActive = tenantStatus === ACTIVE_TENANT_STATUS;
      const integrationAuthorized = capabilityAuthorized(
        authorizationPolicy,
        principal,
        tenantContext,
        PERMISSION.TENANT_INTEGRATIONS_MANAGE,
      );
      const [readiness, connection] = tenantKnown && tenantActive && integrationAuthorized
        ? await Promise.all([
          readinessService.getReadiness({ principal, tenantContext }),
          microsoft365Service.getConnection({ principal, tenantContext, correlationId }),
        ])
        : [null, null];
      const capabilitiesByName = connection?.capabilities || {};
      const capabilities = [
        baseCapability({
          id: CAPABILITY_ID.USER_ADMINISTRATION,
          availability: TENANT_CAPABILITY_AVAILABILITY.INCLUDED,
          authorized: capabilityAuthorized(
            authorizationPolicy,
            principal,
            tenantContext,
            PERMISSION.TENANT_USERS_MANAGE,
          ),
          tenantActive,
          rollout: rolloutState(rolloutPolicy, CAPABILITY_ID.USER_ADMINISTRATION),
        }),
        baseCapability({
          id: CAPABILITY_ID.AUDIT_HISTORY,
          availability: TENANT_CAPABILITY_AVAILABILITY.INCLUDED,
          authorized: capabilityAuthorized(
            authorizationPolicy,
            principal,
            tenantContext,
            PERMISSION.TENANT_AUDIT_READ,
          ),
          tenantActive,
          rollout: rolloutState(rolloutPolicy, CAPABILITY_ID.AUDIT_HISTORY),
        }),
        baseCapability({
          id: CAPABILITY_ID.CONFIGURATION,
          availability: TENANT_CAPABILITY_AVAILABILITY.INCLUDED,
          authorized: true,
          tenantActive,
          rollout: rolloutState(rolloutPolicy, CAPABILITY_ID.CONFIGURATION),
        }),
        microsoftCapability({
          id: CAPABILITY_ID.MICROSOFT_DIRECTORY,
          availability: TENANT_CAPABILITY_AVAILABILITY.INCLUDED,
          authorized: integrationAuthorized,
          tenantActive,
          rollout: rolloutState(rolloutPolicy, CAPABILITY_ID.MICROSOFT_DIRECTORY),
          isEntitled: entitled(readiness, 'microsoftDirectory'),
          readiness,
          connection,
          health: capabilitiesByName.places,
          requiredChecks: Object.freeze([
            Object.freeze({ key: 'tenantIdentityClaimed', reason: 'tenant_identity_required' }),
            Object.freeze({ key: 'microsoft365Connected', reason: 'microsoft_connection_required' }),
            Object.freeze({ key: 'placesPermissionGranted', reason: 'provider_permission_required' }),
          ]),
          clockValue,
        }),
        microsoftCapability({
          id: CAPABILITY_ID.MICROSOFT_CALENDAR,
          availability: TENANT_CAPABILITY_AVAILABILITY.INCLUDED,
          authorized: integrationAuthorized,
          tenantActive,
          rollout: rolloutState(rolloutPolicy, CAPABILITY_ID.MICROSOFT_CALENDAR),
          isEntitled: entitled(readiness, 'microsoftCalendar'),
          readiness,
          connection,
          health: capabilitiesByName.freeBusy,
          requiredChecks: Object.freeze([
            Object.freeze({ key: 'tenantIdentityClaimed', reason: 'tenant_identity_required' }),
            Object.freeze({ key: 'microsoft365Connected', reason: 'microsoft_connection_required' }),
            Object.freeze({ key: 'calendarPermissionGranted', reason: 'provider_permission_required' }),
            Object.freeze({ key: 'freeBusyVerified', reason: 'verification_required' }),
          ]),
          clockValue,
        }),
        microsoftCapability({
          id: CAPABILITY_ID.MICROSOFT_CALENDAR_WRITE,
          availability: TENANT_CAPABILITY_AVAILABILITY.OPTIONAL,
          authorized: integrationAuthorized,
          tenantActive,
          rollout: rolloutState(rolloutPolicy, CAPABILITY_ID.MICROSOFT_CALENDAR_WRITE),
          isEntitled: entitled(readiness, 'microsoftCalendarWrite'),
          readiness,
          connection,
          health: capabilitiesByName.calendarWrite,
          requiredChecks: Object.freeze([
            Object.freeze({ key: 'tenantIdentityClaimed', reason: 'tenant_identity_required' }),
            Object.freeze({ key: 'microsoft365Connected', reason: 'microsoft_connection_required' }),
            Object.freeze({ key: 'calendarPermissionGranted', reason: 'provider_permission_required' }),
          ]),
          clockValue,
        }),
      ];
      if (!tenantKnown) {
        return Object.freeze({
          readOnly: true,
          evaluatedAt: new Date(clockValue).toISOString(),
          tenantStatus: 'unavailable',
          capabilities: Object.freeze(capabilities.map((capability) => unavailable(
            capability.id,
            capability.availability,
            'tenant_state_unknown',
          ))),
        });
      }
      if (capabilities.some((capability) => MICROSOFT_CAPABILITIES.has(capability.id)
        && capability.state === TENANT_CAPABILITY_STATE.OPERATIONAL
        && !integrationAuthorized)) {
        throw new TypeError('CAPABILITY_AUTHORITY_RESULT_INVALID');
      }
      return Object.freeze({
        readOnly: true,
        evaluatedAt: new Date(clockValue).toISOString(),
        tenantStatus,
        capabilities: Object.freeze(capabilities),
      });
    },
  });
}

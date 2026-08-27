import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeTenantBookingPolicy } from '../domain/tenant-booking-policy.js';
import {
  assertTenantSettingsRevision,
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
  TENANT_SETTINGS_SCHEMA_VERSION,
} from './tenant-settings-revision.js';

function correlation(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}
function instant(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_BOOKING_POLICY_CLOCK_INVALID');
  return new Date(value);
}
export function createTenantBookingPolicyService({ repository, authorizationPolicy, auditService, clock = () => Date.now() } = {}) {
  if (!repository || typeof repository.get !== 'function' || typeof repository.update !== 'function') throw new TypeError('TENANT_BOOKING_POLICY_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  if (!auditService || typeof auditService.createEvent !== 'function') throw new TypeError('AUDIT_SERVICE_REQUIRED');
  function authorize(principal, tenantContext) {
    authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_CONFIGURE);
  }
  return Object.freeze({
    async get({ principal, tenantContext, correlationId }) {
      correlation(correlationId); authorize(principal, tenantContext);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_BOOKING_POLICY_NOT_FOUND');
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...current });
    },
    async update({ principal, tenantContext, correlationId, payload }) {
      correlation(correlationId); authorize(principal, tenantContext);
      requireTenantSettingsSchemaVersion(payload?.schemaVersion);
      const expectedRevision = requireTenantSettingsRevision(payload?.expectedRevision);
      const policy = normalizeTenantBookingPolicy(payload?.bookingPolicy);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_BOOKING_POLICY_NOT_FOUND');
      assertTenantSettingsRevision(expectedRevision, current.revision);
      const changedAt = instant(clock);
      const result = await repository.update({
        tenantId: tenantContext.tenantId,
        expectedRevision,
        policy,
        changedAt,
        auditEvent: auditService.createEvent({
          principal,
          tenantContext,
          correlationId,
          action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'tenant_configuration',
          targetId: 'booking_policies',
          previousState: { revision: current.revision },
          newState: { revision: nextTenantSettingsRevision(current.revision) },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: { operation: 'booking_policy_update' },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
          occurredAt: changedAt.toISOString(),
        }),
      });
      if (result?.conflict) assertTenantSettingsRevision(expectedRevision, result.currentRevision);
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...result });
    },
  });
}

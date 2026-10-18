import { PLATFORM_AUDIT_ACTION } from '../../platform/audit/event.js';
import { PLATFORM_OPERATION } from '../../platform/application/platform-operation-contract.js';

const RECOVERIES = new Set([
  PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN, PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT,
  PLATFORM_OPERATION.REPAIR_ROOM_MAPPING, PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY,
  PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS, PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
  PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT, PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT,
]);

// Called only after the bounded complete retained Platform chain is verified.
export function platformProductFacts(events) {
  return events.flatMap((event) => {
    if (event.targetTenantId === null) return [];
    let kind = null;
    if (event.action === PLATFORM_AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED && event.outcome === 'success'
      && event.previousState?.status === 'onboarding' && event.newState?.status === 'ready') kind = 'onboarding_completed';
    if (event.action === PLATFORM_AUDIT_ACTION.RECOVERY_EXECUTED && event.targetType === 'tenant_recovery'
      && RECOVERIES.has(event.metadata?.operation)) {
      if (event.outcome === 'success') kind = 'recovery_completed';
      if (event.outcome === 'failure') kind = 'recovery_failed';
    }
    return kind ? [{ kind, tenantId: event.targetTenantId, targetId: event.targetId, occurredAt: event.occurredAt,
      identity: ['platform_audit', event.sequence, event.eventHash] }] : [];
  });
}

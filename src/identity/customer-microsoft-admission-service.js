import { isInternalUuid } from '../domain/identifiers.js';
import { AUDIT_ACTION,AUDIT_OUTCOME,AUDIT_RETENTION_CLASS } from '../audit/event.js';

const invalid=()=>{ throw new TypeError('CUSTOMER_MICROSOFT_ADMISSION_INPUT_INVALID'); };
function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length!==keys.length || own.some(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
  })) invalid();
}

// No primary-provider claims are accepted here. Durable custody owns both
// proofs and current locked membership; the ordinary session service owns
// credentials. All three persistence adapters must share the same pool.
export function createCustomerMicrosoftAdmissionService({ repository,auditService,sessionService }={}) {
  if (!repository || ['choices','admit','linkConfirmation','confirmLink','accountState']
    .some(method=>typeof repository[method]!=='function')
    || typeof auditService?.createActorEvent!=='function' || typeof sessionService?.issue!=='function') {
    throw new TypeError('CUSTOMER_MICROSOFT_ADMISSION_CONFIGURATION_INVALID');
  }
  function auditEventFor(value) {
    const { tenantId,userId,correlationId,occurredAt,previousSecurityVersion,securityVersion }=value;
    uuid(tenantId);uuid(userId);uuid(correlationId);
    if (typeof occurredAt!=='string' || !Number.isFinite(Date.parse(occurredAt))
      || new Date(occurredAt).toISOString()!==occurredAt || !Number.isSafeInteger(previousSecurityVersion)
      || previousSecurityVersion<1 || previousSecurityVersion>=Number.MAX_SAFE_INTEGER-1
      || securityVersion!==previousSecurityVersion+1) invalid();
    return auditService.createActorEvent({ tenantId,actorUserId: userId,correlationId,occurredAt,
      action: AUDIT_ACTION.TENANT_USER_IDENTITY_LINKED,targetType: 'user',targetId: userId,
      outcome: AUDIT_OUTCOME.SUCCESS,retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
      previousState: { securityVersion: previousSecurityVersion },newState: { securityVersion },
      metadata: { provider: 'microsoft_entra',source: 'explicit_link' } });
  }
  return Object.freeze({
    accountState(input) {
      exact(input,['principal']);return repository.accountState({ principal: input.principal });
    },
    choices(input) {
      exact(input,['flowId','browserToken']);return repository.choices({ flowId: uuid(input.flowId),browserToken: input.browserToken });
    },
    select(input,command) {
      exact(input,['flowId','browserToken','csrfToken','correlationId']);exact(command,['membershipId']);
      const correlationId=uuid(input.correlationId);
      return repository.admit({ ...input,flowId: uuid(input.flowId),correlationId,membershipId: uuid(command.membershipId),
        groupAuditEventFor({ tenantId,userId,conferenceManager,tenantAdmin }) {
          uuid(tenantId);uuid(userId);
          return auditService.createActorEvent({ tenantId,actorUserId: userId,correlationId,
            action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,targetType: 'user',targetId: userId,
            outcome: AUDIT_OUTCOME.SUCCESS,retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
            newState: { conferenceManager,tenantAdmin },metadata: { operation: 'microsoft_group_sync' } });
        },
        issueSession: identity=>sessionService.issue(identity,{ correlationId }) });
    },
    linkConfirmation(input) {
      exact(input,['flowId','browserToken','principal']);return repository.linkConfirmation({ ...input,flowId: uuid(input.flowId) });
    },
    confirmLink(input,command) {
      exact(input,['flowId','browserToken','csrfToken','correlationId','principal']);exact(command,['confirm']);
      if (command.confirm!==true) invalid();const correlationId=uuid(input.correlationId);
      return repository.confirmLink({ ...input,flowId: uuid(input.flowId),correlationId,auditEventFor,
        issueSession: identity=>sessionService.issue(identity,{ correlationId }) });
    },
  });
}

import { isInternalUuid } from '../domain/identifiers.js';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';

function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CUSTOMER_EMAIL_ADMISSION_INPUT_INVALID');
  return value.toLowerCase();
}

// The repository owns current locked admission; existing SessionService owns
// ordinary session generation. Runtime composition must supply their same pool.
export function createCustomerEmailAdmissionService({ repository,auditService,sessionService } = {}) {
  if (!repository || ['choices','admit'].some(method => typeof repository[method] !== 'function')
    || typeof auditService?.createActorEvent !== 'function' || typeof sessionService?.issue !== 'function') {
    throw new TypeError('CUSTOMER_EMAIL_ADMISSION_CONFIGURATION_INVALID');
  }
  function auditFor(correlationId) {
    return ({ kind,tenantId,userId,invitationId,revision,occurredAt }) => {
      uuid(tenantId); uuid(userId);
      if (!['provision','accept'].includes(kind) || typeof occurredAt !== 'string'
        || !Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) {
        throw new TypeError('CUSTOMER_EMAIL_ADMISSION_AUDIT_INVALID');
      }
      if (kind === 'accept' && (!isInternalUuid(invitationId) || !Number.isSafeInteger(revision)
        || revision < 2 || revision >= Number.MAX_SAFE_INTEGER)) throw new TypeError('CUSTOMER_EMAIL_ADMISSION_AUDIT_INVALID');
      return auditService.createActorEvent({ tenantId,actorUserId: userId,correlationId,occurredAt,
        action: kind === 'provision' ? AUDIT_ACTION.TENANT_USER_PROVISIONED : AUDIT_ACTION.TENANT_ONBOARDING_INVITED,
        targetType: kind === 'provision' ? 'user' : 'customer_invitation',targetId: kind === 'provision' ? userId : invitationId,
        outcome: AUDIT_OUTCOME.SUCCESS,retentionClass: AUDIT_RETENTION_CLASS.SECURITY,previousState: null,
        newState: kind === 'provision' ? { active: true,role: 'employee' } : { revision },
        metadata: kind === 'provision' ? { provider: 'email_code',source: 'invitation' } : { operation: 'accept' } });
    };
  }
  return Object.freeze({
    choices({ challengeId,browserToken } = {}) { return repository.choices({ challengeId: uuid(challengeId),browserToken }); },
    async select({ challengeId,browserToken,csrfToken,correlationId } = {}, command) {
      challengeId = uuid(challengeId); correlationId = uuid(correlationId);
      if (!command || typeof command !== 'object' || Array.isArray(command)
        || ![Object.prototype,null].includes(Object.getPrototypeOf(command))) throw new TypeError('CUSTOMER_EMAIL_ADMISSION_INPUT_INVALID');
      const keys = Reflect.ownKeys(command),property = Object.getOwnPropertyDescriptor(command,'membershipId');
      if (keys.length !== 1 || keys[0] !== 'membershipId' || !property?.enumerable || !Object.hasOwn(property,'value')) {
        throw new TypeError('CUSTOMER_EMAIL_ADMISSION_INPUT_INVALID');
      }
      return repository.admit({ challengeId,browserToken,csrfToken,membershipId: uuid(property.value),correlationId,
        auditEventFor: auditFor(correlationId),issueSession: identity => sessionService.issue(identity,{ correlationId }) });
    },
  });
}

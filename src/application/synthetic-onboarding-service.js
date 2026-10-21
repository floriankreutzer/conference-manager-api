import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeSyntheticOnboardingCommand,SyntheticOnboardingError } from '../domain/synthetic-onboarding.js';
import { PERMISSION } from '../authorization/policy.js';
import { AUDIT_ACTION,AUDIT_OUTCOME,AUDIT_RETENTION_CLASS } from '../audit/event.js';

export function createSyntheticOnboardingService({ repository,authorizationPolicy,auditService }={}) {
  if (!repository || ['view','importRooms','transition'].some(name=>typeof repository[name]!=='function')
    || typeof authorizationPolicy?.requireTenantPermission!=='function' || typeof auditService?.createEvent!=='function') {
    throw new TypeError('SYNTHETIC_ONBOARDING_SERVICE_CONFIGURATION_INVALID');
  }
  function authorize(context) {
    if (!isInternalUuid(context?.correlationId) || context.principal?.tenantId!==context.tenantContext?.tenantId) {
      throw new SyntheticOnboardingError('SYNTHETIC_ONBOARDING_INPUT_INVALID');
    }
    authorizationPolicy.requireTenantPermission(context.principal,context.tenantContext,PERMISSION.TENANT_INTEGRATIONS_MANAGE);
  }
  function event(context,action,newState,previousState=null) {
    return auditService.createEvent({ principal: context.principal,tenantContext: context.tenantContext,
      correlationId: context.correlationId,action,targetType: 'tenant',targetId: context.tenantContext.tenantId,
      previousState,newState,outcome: AUDIT_OUTCOME.SUCCESS,retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE });
  }
  return Object.freeze({
    async view(context) { authorize(context);return repository.view({ principal: context.principal }); },
    async importRooms(context,input) {
      authorize(context);const command=normalizeSyntheticOnboardingCommand(input,'import');
      return repository.importRooms({ principal: context.principal,...command,
        auditEventFor: ({ importedCount,revision })=>event(context,AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          { importedCount,locationsRevision: revision },{ locationsRevision: command.expectedRevision }) });
    },
    async transition(context,input) {
      authorize(context);const command=normalizeSyntheticOnboardingCommand(input,'lifecycle');
      return repository.transition({ principal: context.principal,...command,
        auditEvent: event(context,AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED,{ status: command.targetStatus },
          { status: command.expectedStatus }) });
    },
  });
}

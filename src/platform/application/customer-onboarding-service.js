import { authorizePlatformOperation,createMutationEvidence,PLATFORM_OPERATION,
  requireDisplayName,requireReason,requireInternalId } from './platform-operation-contract.js';
import { PlatformOperationInputError,PlatformOperationUnavailableError } from './platform-operation-errors.js';

function exact(value,fields) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new PlatformOperationInputError();
  const keys=Reflect.ownKeys(value);
  if (keys.length!==fields.length || keys.some(key => {
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !fields.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) throw new PlatformOperationInputError();
}
function invitees(value,commandId,owner,contract) {
  const { normalizeIntent: normalizeCustomerInvitationIntent,normalizeBatch: normalizeCustomerInvitationBatch }=contract;
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype || value.length>19
    || Reflect.ownKeys(value).length!==value.length+1) throw new PlatformOperationInputError();
  const source=[];
  try {
    for (let i=0;i<value.length;i++) {
      const field=Object.getOwnPropertyDescriptor(value,String(i));
      if (!field?.enumerable || !Object.hasOwn(field,'value')) throw new PlatformOperationInputError();
      source.push(normalizeCustomerInvitationIntent(field.value));
    }
    if (new Set(source.map(row=>row.recipient)).size!==source.length) throw new PlatformOperationInputError();
    const duplicate=source.findIndex(row=>row.recipient===owner.recipient);
    if (duplicate===-1) source.push(owner);
    else source[duplicate]=normalizeCustomerInvitationIntent({ ...source[duplicate],
      roles: [...new Set([...source[duplicate].roles,'tenant_admin'])],locale: owner.locale });
    return normalizeCustomerInvitationBatch({ commandId,invitations: source }).invitations;
  } catch { throw new PlatformOperationInputError('PLATFORM_CUSTOMER_INVITATION_INPUT_INVALID'); }
}

// Real customer onboarding only. The configured owner contact is explicit
// protected configuration, never an inferred Microsoft/email claim or recipient
// supplied by the browser. No Customer principal or role is manufactured here.
export function createPlatformCustomerOnboardingService({ repository,platformAuthorizationPolicy,tenantTargetPolicy,
  operationEvidenceFactory,invitationContract,environment,ownerRecipient,ownerLocale='de',idFactory } = {}) {
  if (!invitationContract || ['normalizeIntent','normalizeBatch','projectInvitations']
    .some(method=>typeof invitationContract[method]!=='function') || typeof repository?.create!=='function'
    || typeof platformAuthorizationPolicy?.authorize!=='function'
    || typeof tenantTargetPolicy?.authorizeCreation!=='function' || typeof operationEvidenceFactory?.createMutation!=='function'
    || typeof idFactory!=='function' || !['dev','int','prod'].includes(environment)) {
    throw new TypeError('PLATFORM_CUSTOMER_ONBOARDING_CONFIGURATION_INVALID');
  }
  let owner;
  try { owner=invitationContract.normalizeIntent({ recipient: ownerRecipient,roles: ['tenant_admin'],locale: ownerLocale }); }
  catch { throw new TypeError('PLATFORM_CUSTOMER_OWNER_CONTACT_REQUIRED'); }
  return Object.freeze({
    async createTenant(input) {
      exact(input,['operatorContext','displayName','reason','confirmation','correlationId','idempotencyKey','invitations']);
      const displayName=requireDisplayName(input.displayName),reason=requireReason(input.reason);
      const correlationId=requireInternalId(input.correlationId),commandId=requireInternalId(input.idempotencyKey);
      exact(input.confirmation,['action','displayName']);
      if (input.confirmation.action!==PLATFORM_OPERATION.TENANT_INVITATION_CREATE
        || input.confirmation.displayName!==displayName) throw new PlatformOperationInputError('PLATFORM_OPERATION_CONFIRMATION_INVALID');
      const authorization=await authorizePlatformOperation({ authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy,
        operatorContext: input.operatorContext,operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,tenantCreation: true });
      const invitations=invitees(input.invitations,commandId,owner,invitationContract),proposedTenantId=requireInternalId(idFactory());
      const result=await repository.create({ authorization,environment,proposedTenantId,commandId,displayName,reason,
        correlationId,invitations,
        evidenceFor: ({ tenantId,invitationId=null,occurredAt }) => {
          if (tenantId!==proposedTenantId || (invitationId!==null && requireInternalId(invitationId)!==invitationId)
            || typeof occurredAt!=='string' || !Number.isFinite(Date.parse(occurredAt))
            || new Date(occurredAt).toISOString()!==occurredAt) throw new PlatformOperationUnavailableError();
          return createMutationEvidence({
          evidenceFactory: operationEvidenceFactory,authorization,operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,
          tenantId,correlationId,reason,occurredAt,previousState: null,
          target: invitationId===null ? { type: 'tenant',id: tenantId } : { type: 'customer_invitation',id: invitationId },
          requestedState: invitationId===null ? { status: 'onboarding',invitationCount: invitations.length }
            : { revision: 1,status: 'issued' },
        }); },
      });
      try { exact(result,['outcome','tenant','invitations']);exact(result.tenant,['id','displayName','status']); }
      catch { throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_ONBOARDING_RESULT_INVALID'); }
      if (!['updated','idempotent'].includes(result.outcome) || !result.tenant
        || result.tenant.displayName!==displayName || result.tenant.status!=='onboarding'
        || (result.outcome==='updated' && result.tenant.id!==proposedTenantId)) {
        throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_ONBOARDING_RESULT_INVALID');
      }
      let tenantId,projected;
      try {
        tenantId=requireInternalId(result.tenant.id);
        projected=invitationContract.projectInvitations(result.invitations,20,tenantId,environment);
      } catch { throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_ONBOARDING_RESULT_INVALID'); }
      if (projected.length!==invitations.length || projected.some((row,index) => row.state!=='pending'
        || row.revision!==1 || row.delivery!=='queued' || row.recipient!==invitations[index].recipient
        || row.locale!==invitations[index].locale || JSON.stringify(row.roles)!==JSON.stringify(invitations[index].roles))) {
        throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_ONBOARDING_RESULT_INVALID');
      }
      return Object.freeze({ schemaVersion: 1,outcome: result.outcome,
        tenant: Object.freeze({ id: tenantId,displayName,status: 'onboarding' }),invitations: projected });
    },
  });
}

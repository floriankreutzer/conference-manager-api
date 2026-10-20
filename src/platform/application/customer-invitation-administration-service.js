import { authorizePlatformOperation,createMutationEvidence,createSensitiveReadEvidence,PLATFORM_OPERATION,
  requireInternalId,requireReason,requireRevision,requireLimit,requireConfirmation } from './platform-operation-contract.js';
import { PlatformOperationInputError,PlatformOperationUnavailableError } from './platform-operation-errors.js';

function exact(value,fields) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new PlatformOperationInputError();
  const keys=Reflect.ownKeys(value);
  if (keys.length!==fields.length || keys.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !fields.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) throw new PlatformOperationInputError();
}
export function createPlatformCustomerInvitationAdministrationService({ repository,platformAuthorizationPolicy,
  tenantTargetPolicy,operationEvidenceFactory,invitationContract,environment } = {}) {
  if (!repository || ['list','issueBatch','mutate'].some(name=>typeof repository[name]!=='function')
    || typeof platformAuthorizationPolicy?.authorize!=='function' || typeof tenantTargetPolicy?.authorize!=='function'
    || !operationEvidenceFactory || ['createMutation','createSensitiveRead'].some(name=>typeof operationEvidenceFactory[name]!=='function')
    || !invitationContract || ['normalizeBatch','projectInvitations'].some(name=>typeof invitationContract[name]!=='function')
    || !['dev','int','prod'].includes(environment)) throw new TypeError('PLATFORM_CUSTOMER_INVITATION_CONFIGURATION_INVALID');
  function authorize(input,operation) {
    return authorizePlatformOperation({ authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy,
      operatorContext: input.operatorContext,operation,tenantId: requireInternalId(input.tenantId) });
  }
  function evidence(input,authorization,operation) {
    return ({ invitationId,nextRevision,occurredAt })=>{
      invitationId=requireInternalId(invitationId);requireRevision(nextRevision);
      if (typeof occurredAt!=='string' || !Number.isFinite(Date.parse(occurredAt))
        || new Date(occurredAt).toISOString()!==occurredAt) throw new PlatformOperationUnavailableError();
      return createMutationEvidence({ evidenceFactory: operationEvidenceFactory,authorization,operation,
        tenantId: input.tenantId,correlationId: input.correlationId,reason: input.reason,occurredAt,
        target: { type: 'customer_invitation',id: invitationId },
        previousState: nextRevision===1 ? null : { revision: nextRevision-1 },requestedState: { revision: nextRevision,
          status: operation===PLATFORM_OPERATION.INVITATION_REVOKE ? 'revoked' : 'issued' } });
    };
  }
  function projected(result,input,maximum) {
    try {
      exact(result,['outcome','invitations']);
      if (!['updated','idempotent'].includes(result.outcome)) throw new Error('INVALID');
      return invitationContract.projectInvitations(result.invitations,maximum,input.tenantId,environment);
    } catch { throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_INVITATION_RESULT_INVALID'); }
  }
  async function mutate(input,operation) {
    exact(input,['operatorContext','tenantId','invitationId','expectedRevision','reason','confirmation','correlationId','idempotencyKey']);
    const tenantId=requireInternalId(input.tenantId),invitationId=requireInternalId(input.invitationId);
    const expectedRevision=requireRevision(input.expectedRevision),reason=requireReason(input.reason);
    if (expectedRevision>=Number.MAX_SAFE_INTEGER-1) throw new PlatformOperationInputError();
    const correlationId=requireInternalId(input.correlationId),commandId=requireInternalId(input.idempotencyKey);
    requireConfirmation(input.confirmation,{ action: operation,tenantId });
    const authorization=await authorize(input,operation),values={ ...input,tenantId,reason,correlationId };
    const result=await repository.mutate({ authorization,environment,tenantId,invitationId,expectedRevision,operation,
      reason,correlationId,commandId,evidenceFor: evidence(values,authorization,operation) });
    const rows=projected(result,values,1),row=rows[0];
    if (rows.length!==1 || row.id!==invitationId || row.revision!==expectedRevision+1
      || row.state!==(operation===PLATFORM_OPERATION.INVITATION_REVOKE ? 'revoked' : 'pending')
      || (operation===PLATFORM_OPERATION.INVITATION_REISSUE && row.delivery!=='queued')) {
      throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_INVITATION_RESULT_INVALID');
    }
    return Object.freeze({ schemaVersion: 1,outcome: result.outcome,invitation: row });
  }
  return Object.freeze({
    async list(input) {
      exact(input,['operatorContext','tenantId','correlationId','limit','afterInvitationId']);
      const tenantId=requireInternalId(input.tenantId),correlationId=requireInternalId(input.correlationId);
      const limit=requireLimit(input.limit,{ defaultValue: 50,maximum: 100 });
      const afterInvitationId=input.afterInvitationId===null ? null : requireInternalId(input.afterInvitationId);
      const authorization=await authorize(input,PLATFORM_OPERATION.INVITATION_LIST);
      const result=await repository.list({ authorization,environment,tenantId,correlationId,limit,afterInvitationId,
        evidenceFor: ({ occurredAt })=>createSensitiveReadEvidence({ evidenceFactory: operationEvidenceFactory,authorization,
          operation: PLATFORM_OPERATION.INVITATION_LIST,tenantId,correlationId,occurredAt,
          target: { type: 'customer_invitations',id: tenantId } }) });
      let items;
      try { items=invitationContract.projectInvitations(result,limit,tenantId,environment); }
      catch { throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_INVITATION_RESULT_INVALID'); }
      if (items.some((row,index)=>row.id<=(index===0 ? afterInvitationId ?? '' : items[index-1].id))) {
        throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_INVITATION_RESULT_INVALID');
      }
      return Object.freeze({ schemaVersion: 1,items });
    },
    async issueBatch(input) {
      exact(input,['operatorContext','tenantId','reason','confirmation','correlationId','idempotencyKey','invitations']);
      const tenantId=requireInternalId(input.tenantId),reason=requireReason(input.reason);
      const correlationId=requireInternalId(input.correlationId),commandId=requireInternalId(input.idempotencyKey);
      requireConfirmation(input.confirmation,{ action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,tenantId });
      let normalized;
      try { normalized=invitationContract.normalizeBatch({ commandId,invitations: input.invitations }); }
      catch { throw new PlatformOperationInputError('PLATFORM_CUSTOMER_INVITATION_INPUT_INVALID'); }
      const operation=PLATFORM_OPERATION.TENANT_INVITATION_CREATE,authorization=await authorize(input,operation);
      const values={ ...input,tenantId,reason,correlationId };
      const result=await repository.issueBatch({ authorization,environment,tenantId,reason,correlationId,commandId,
        invitations: normalized.invitations,evidenceFor: evidence(values,authorization,operation) });
      const invitations=projected(result,values,20);
      if (invitations.length!==normalized.invitations.length || invitations.some((row,index)=>row.revision!==1
        || row.state!=='pending' || row.delivery!=='queued' || row.recipient!==normalized.invitations[index].recipient
        || row.locale!==normalized.invitations[index].locale
        || JSON.stringify(row.roles)!==JSON.stringify(normalized.invitations[index].roles))) {
        throw new PlatformOperationUnavailableError('PLATFORM_CUSTOMER_INVITATION_RESULT_INVALID');
      }
      return Object.freeze({ schemaVersion: 1,outcome: result.outcome,invitations });
    },
    reissue(input) { return mutate(input,PLATFORM_OPERATION.INVITATION_REISSUE); },
    revoke(input) { return mutate(input,PLATFORM_OPERATION.INVITATION_REVOKE); },
  });
}

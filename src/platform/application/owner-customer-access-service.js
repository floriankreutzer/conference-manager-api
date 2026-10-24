import { isInternalUuid,isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { normalizeOwnerCustomerAccessScope,normalizeOwnerCustomerAccessIntent,
  ownerCustomerAccessOperationHash,ownerCustomerAccessRedirect } from '../../domain/owner-customer-handoff.js';
import { createOwnerCustomerAccessPolicy } from '../identity/owner-customer-access-policy.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PlatformAuthorizationError } from '../identity/errors.js';

function exact(value,keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const fields=Reflect.ownKeys(value);
  if (fields.length!==keys.length || fields.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) invalid();
}
function invalid() { throw new TypeError('OWNER_CUSTOMER_ACCESS_SERVICE_INPUT_INVALID'); }
function denied() { throw new PlatformAuthorizationError('OWNER_CUSTOMER_ACCESS_DENIED'); }
function selection(intent) { const { state,...value }=intent;return value; }

// This service cannot issue a Customer session or manufacture a proof. The
// owned root must inject its shared Microsoft operation instance, never the
// separately configured exclusive synthetic instance. Persistence independently
// verifies the designated owner, REAL target and exact consumed shared proof.
export function createOwnerCustomerAccessService({ repository,microsoftOperationService,authorizationPolicy,
  browserBinding,scope: rawScope }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope),policy=createOwnerCustomerAccessPolicy(scope);
  if (['prepare','binding','approve'].some(name=>typeof repository?.[name]!=='function')
    || typeof microsoftOperationService?.verifiedOperationWithContinuation!=='function'
    || typeof authorizationPolicy?.authorize!=='function' || typeof browserBinding?.stateVerifier!=='function') {
    throw new TypeError('OWNER_CUSTOMER_ACCESS_SERVICE_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    async operationHash(input) {
      exact(input,['principal','intent']);const intent=normalizeOwnerCustomerAccessIntent(input.intent),value=selection(intent);
      const principal=policy.prepare(input.principal,value);
      const binding=await repository.prepare({ principal,selection: value,stateHash: browserBinding.stateVerifier(intent.state) });
      if (!binding) denied();return ownerCustomerAccessOperationHash(scope,value,binding);
    },
    async approve(input) {
      exact(input,['proofContext','intent','correlationId']);if (!isInternalUuid(input.correlationId)) invalid();
      const intent=normalizeOwnerCustomerAccessIntent(input.intent),value=selection(intent);
      const stateHash=browserBinding.stateVerifier(intent.state);
      const binding=await repository.binding({ flowId: value.flowId,stateHash });if (!binding) denied();
      const operationHash=ownerCustomerAccessOperationHash(scope,value,binding);
      const proof=microsoftOperationService.verifiedOperationWithContinuation(input.proofContext,operationHash);
      const { principal,continuationPrincipal }=policy.continuation(proof.principal,proof.continuationPrincipal,value);
      if (await authorizationPolicy.authorize(principal,PLATFORM_PERMISSION.OPERATOR_MANAGE)!==true) denied();
      const result=await repository.approve({ principal,continuationPrincipal,selection: value,stateHash,
        expectedBinding: binding,operationHash,correlationId: input.correlationId.toLowerCase() });
      exact(result,['status','code','expiresAt']);
      if (result.status!=='approved' || !isOpaqueBrowserToken(result.code) || typeof result.expiresAt!=='string'
        || !Number.isFinite(Date.parse(result.expiresAt)) || new Date(result.expiresAt).toISOString()!==result.expiresAt) {
        throw new Error('OWNER_CUSTOMER_ACCESS_APPROVAL_RESULT_INVALID');
      }
      // Private result only: exact proof, audit and normal continuation must
      // commit together before transport can expose this fixed redirect.
      return Object.freeze({ status: 'redirect',location: ownerCustomerAccessRedirect(scope,{ state: intent.state,code: result.code }) });
    },
  });
}

import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizeSyntheticHandoffScope,normalizeSyntheticHandoffIntent,syntheticHandoffOperationHash,syntheticHandoffCustomerRedirect }
  from '../../domain/synthetic-handoff.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PlatformAuthorizationError } from '../identity/errors.js';
import { syntheticOperationAssurance } from '../../domain/synthetic-operation-assurance.js';

function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new TypeError('SYNTHETIC_HANDOFF_SERVICE_INPUT_INVALID');
  const fields=Reflect.ownKeys(value);
  if (fields.length!==keys.length || fields.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) throw new TypeError('SYNTHETIC_HANDOFF_SERVICE_INPUT_INVALID');
}
function selection(intent) { const { state,...value }=intent;return value; }
function denied() { throw new PlatformAuthorizationError('SYNTHETIC_HANDOFF_DENIED'); }
function sameValues(left,right) { return left.length===right.length && left.every(item=>right.includes(item)); }

// A selected role or even an elevated principal is never proof. Approval consumes
// the exact private passkey context AND its future normal-MFA continuation, so an
// old/temporary session cannot become the Customer delegation's source session.
export function createSyntheticHandoffService({ repository,passkeyService,authorizationPolicy,browserBinding,scope,
  assuranceMode='application_passkey' }={}) {
  const assurance=syntheticOperationAssurance(assuranceMode);
  scope=normalizeSyntheticHandoffScope(scope);
  if (['prepare','binding','approve'].some(method=>typeof repository?.[method]!=='function')
    || typeof passkeyService?.verifiedOperationWithContinuation!=='function' || typeof authorizationPolicy?.authorize!=='function'
    || typeof browserBinding?.stateVerifier!=='function') throw new TypeError('SYNTHETIC_HANDOFF_SERVICE_CONFIGURATION_INVALID');
  return Object.freeze({
    async operationHash(input) {
      exact(input,['principal','intent']);const principal=normalizePlatformPrincipal(input.principal);
      const intent=normalizeSyntheticHandoffIntent(input.intent),value=selection(intent);
      if (principal.operatorId!==value.operatorId || principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
        || principal.assurance.level!=='mfa' || principal.assurance.authenticationContext!==assurance.normalContext
        || principal.session.securityEpoch!==scope.platformSecurityEpoch
        || !principal.permissions.includes(PLATFORM_PERMISSION.LIFECYCLE_MANAGE)) denied();
      // Preparing an exact challenge is not the privileged operation itself.
      // The locked repository still checks the actual current normal session,
      // owner, generation, selected persona and two active credentials.
      const binding=await repository.prepare({ principal,selection: value,stateHash: browserBinding.stateVerifier(intent.state) });
      if (!binding) denied();return syntheticHandoffOperationHash(scope,value,binding);
    },
    async approve(input) {
      exact(input,['proofContext','intent','correlationId']);
      if (!isInternalUuid(input.correlationId)) throw new TypeError('SYNTHETIC_HANDOFF_SERVICE_INPUT_INVALID');
      const intent=normalizeSyntheticHandoffIntent(input.intent),value=selection(intent);
      const stateHash=browserBinding.stateVerifier(intent.state);
      const binding=await repository.binding({ flowId: value.flowId,stateHash });
      if (!binding) denied();const hash=syntheticHandoffOperationHash(scope,value,binding);
      const verified=passkeyService.verifiedOperationWithContinuation(input.proofContext,hash);
      const principal=normalizePlatformPrincipal(verified.principal),future=normalizePlatformPrincipal(verified.continuationPrincipal);
      if (principal.operatorId!==value.operatorId || principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
        || principal.assurance.level!=='step_up' || principal.assurance.authenticationContext!==assurance.freshContext
        || principal.session.securityEpoch!==scope.platformSecurityEpoch || future.operatorId!==principal.operatorId
        || future.securityVersion!==principal.securityVersion || future.session.id===principal.session.id
        || future.session.securityEpoch!==scope.platformSecurityEpoch || future.assurance.level!=='mfa'
        || future.assurance.authenticationContext!==assurance.normalContext
        || future.assurance.authenticatedAt!==principal.assurance.authenticatedAt
        || ['provider','tenantReference','subjectReference'].some(key=>future.providerIdentity[key]!==principal.providerIdentity[key])
        || future.targetScope.mode!==principal.targetScope.mode || !sameValues(future.roles,principal.roles)
        || !sameValues(future.permissions,principal.permissions)
        || await authorizationPolicy.authorize(principal,PLATFORM_PERMISSION.LIFECYCLE_MANAGE)!==true) denied();
      const result=await repository.approve({ principal,continuationPrincipal: future,selection: value,stateHash,
        expectedBinding: binding,operationHash: hash,correlationId: input.correlationId.toLowerCase() });
      exact(result,['status','code','expiresAt']);
      if (result.status!=='approved' || typeof result.code!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(result.code)
        || Buffer.from(result.code,'base64url').toString('base64url')!==result.code || typeof result.expiresAt!=='string'
        || !Number.isFinite(Date.parse(result.expiresAt)) || new Date(result.expiresAt).toISOString()!==result.expiresAt) {
        throw new Error('SYNTHETIC_HANDOFF_APPROVAL_RESULT_INVALID');
      }
      // Private mutation result only. The HTTP root must await the whole passkey
      // completion/commit before sending this fixed redirect or normal cookie.
      return Object.freeze({ status: 'redirect',
        location: syntheticHandoffCustomerRedirect(scope,{ state: intent.state,code: result.code }) });
    },
  });
}

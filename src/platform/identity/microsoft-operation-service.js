import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { isInternalUuid,isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { permissionsForPlatformRoles } from './policy.js';
import { normalizePlatformPrincipal,normalizeTrustedPlatformIdentity } from './principal.js';
import { PlatformIdentityError } from './errors.js';
import {
  serializePlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie,
  clearPlatformMicrosoftOperationBrowserCookie,clearPlatformMicrosoftOperationCookie,
} from './microsoft-operation-cookie.js';

const HASH=/^[a-f0-9]{64}$/,NORMAL='cm:ms:mfa:v1',FRESH='cm:ms:fresh:v1',TTL_SECONDS=120;
const REJECTION_REASONS=new Map([
  ['PLATFORM_ENTRA_AUTHENTICATION_NOT_FRESH','authentication_stale'],
  ['PLATFORM_ENTRA_ISSUED_AT_NOT_FRESH','issuance_stale'],
  ['PLATFORM_ENTRA_NONCE_INVALID','nonce_rejected'],
  ['PLATFORM_MICROSOFT_MFA_REQUIRED','mfa_missing'],
  ['PLATFORM_ENTRA_CODE_REDEMPTION_FAILED','exchange_failed'],
  ['PLATFORM_ENTRA_TOKEN_EXPIRED','token_expired'],
  ['PLATFORM_ENTRA_TOKEN_EXPIRY_MISSING','expiry_missing'],
  ['PLATFORM_ENTRA_TOKEN_EXPIRY_INVALID','expiry_invalid'],
]);
const reject=()=>{ throw new PlatformIdentityError('PLATFORM_MICROSOFT_OPERATION_REJECTED'); };
function instant(value) {
  if (typeof value!=='string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString()!==value) reject();
  return Date.parse(value);
}
function ordinary(value,securityEpoch) {
  let principal;try { principal=normalizePlatformPrincipal(value); } catch { reject(); }
  if (principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || principal.assurance.level!=='mfa'
    || principal.assurance.authenticationContext!==NORMAL || principal.session.securityEpoch!==securityEpoch) reject();
  return principal;
}
function sameAuthority(left,right) {
  return left.operatorId===right.operatorId && left.securityVersion===right.securityVersion
    && left.roles.join(',')===right.roles.join(',') && left.targetScope.mode===right.targetScope.mode
    && ['provider','tenantReference','subjectReference'].every(key=>left.providerIdentity[key]===right.providerIdentity[key]);
}
function identityForProof(proof,level) {
  if (proof?.providerIdentity?.provider!==PLATFORM_ENTRA_PROVIDER) reject();
  return normalizeTrustedPlatformIdentity({ operatorId: proof.operatorId,providerIdentity: proof.providerIdentity,
    roles: proof.roles,permissions: permissionsForPlatformRoles(proof.roles),securityVersion: proof.securityVersion,
    targetScope: { mode: proof.scopeMode,securityVersion: proof.securityVersion },
    assurance: { level,authenticationContext: level==='mfa' ? NORMAL : FRESH,authenticatedAt: proof.authenticatedAt } });
}

// Owns only the provider/opaque-context protocol. The owned repository must
// recheck source authority and consume proof with mutation/session/audit in its
// fixed transaction. Callback verification never executes a business mutation.
export function createPlatformMicrosoftOperationService({ repository,entraClient,claimPolicy,sessionService,
  environment,protectedSecurityEpoch,securityEpoch,transactionSecret,clock=()=>Date.now(),
  onRejection=()=>{},tokenFactory=()=>randomBytes(32).toString('base64url'),idFactory=randomUUID }={}) {
  if (['create','findPending','verify','reject','authenticate'].some(name=>typeof repository?.[name]!=='function')
    || ['authorizationUrl','redeemAuthorizationCode','verify'].some(name=>typeof entraClient?.[name]!=='function')
    || typeof claimPolicy?.normalize!=='function'
    || ['resolvePrincipal','rotate','issue','revoke'].some(name=>typeof sessionService?.[name]!=='function')
    || !['dev','int','prod'].includes(environment) || !isInternalUuid(protectedSecurityEpoch)
    || !Number.isSafeInteger(securityEpoch) || securityEpoch<1 || typeof clock!=='function'
    || typeof onRejection!=='function' || typeof tokenFactory!=='function' || typeof idFactory!=='function'
    || typeof transactionSecret!=='string' || Buffer.byteLength(transactionSecret)<32
    || Buffer.byteLength(transactionSecret)>512) throw new TypeError('PLATFORM_MICROSOFT_OPERATION_CONFIGURATION_INVALID');
  function reportRejection(stage,error=null) {
    const reason=error===null ? 'provider_refused' : error instanceof PlatformIdentityError
      ? REJECTION_REASONS.get(error.code) ?? 'rejected' : 'unavailable';
    // A diagnostic sink cannot change proof, cookie, rejection or audit behavior.
    try { onRejection(Object.freeze({ stage,reason })); } catch { /* Non-authoritative telemetry. */ }
  }
  const secret=Buffer.from(transactionSecret),epoch=protectedSecurityEpoch.toLowerCase(),contexts=new WeakMap();
  const mac=(purpose,value,encoding='hex')=>createHmac('sha256',secret)
    .update(`platform-microsoft-operation:v1:${environment}:${epoch}:${securityEpoch}:${purpose}:${value}`).digest(encoding);
  const browser=state=>mac('browser',state,'base64url');
  const nonce=state=>mac('nonce',state,'base64url');
  function locate(cookie,state) {
    if (typeof cookie!=='string' || cookie.length!==87 || !isOpaqueBrowserToken(state)) reject();
    const parts=cookie.split('.');
    if (parts.length!==2 || parts[0]!==state || !parts.every(isOpaqueBrowserToken)
      || !timingSafeEqual(Buffer.from(parts[1]),Buffer.from(browser(state)))) reject();
    return { environment,protectedSecurityEpoch: epoch,securityEpoch,stateHash: mac('state',state),
      browserHash: mac('browser-proof',parts[1]) };
  }
  function pending(record,expectedStatus) {
    if (!record || record.status!==expectedStatus || !isInternalUuid(record.id) || !isInternalUuid(record.operatorId)
      || !isInternalUuid(record.expectedSessionId) || !Number.isSafeInteger(record.operatorSecurityVersion)
      || record.operatorSecurityVersion<1 || !HASH.test(record.operationHash || '') || !HASH.test(record.nonceHash || '')
      || !isInternalUuid(record.correlationId) || record.providerIdentity?.provider!==PLATFORM_ENTRA_PROVIDER
      || !isInternalUuid(record.providerIdentity.tenantReference) || !isInternalUuid(record.providerIdentity.subjectReference)
      || instant(record.expiresAt)<=clock() || instant(record.expiresAt)>instant(record.createdAt)+TTL_SECONDS*1000
      || instant(record.expiresAt)<=instant(record.createdAt)
      || instant(record.createdAt)>clock()+60000) reject();
    return record;
  }
  function verifiedContext(context,operationHash,continuation=false) {
    const proof=contexts.get(context);contexts.delete(context);
    if (!proof || proof.operationHash!==operationHash || continuation && !proof.continuationPrincipal) reject();
    return proof;
  }
  async function requireCurrentSource(record,request) {
    const current=ordinary(await sessionService.resolvePrincipal(request),securityEpoch);
    if (current.operatorId!==record.operatorId || current.securityVersion!==record.operatorSecurityVersion
      || current.session.id!==record.expectedSessionId || ['provider','tenantReference','subjectReference']
        .some(key=>current.providerIdentity[key]!==record.providerIdentity[key])) reject();
    return current;
  }
  async function finish(input,mutation,requiresContinuation) {
    if (typeof mutation!=='function' || !HASH.test(input?.operationHash || '')) reject();
    const lookup=locate(input.cookie,input.state),record=pending(await repository.findPending(lookup),'verified');
    if (record.operationHash!==input.operationHash) reject();
    const current=await requireCurrentSource(record,input.request);
    const completed=await repository.authenticate({ ...lookup,id: record.id,operationHash: input.operationHash,
      expectedPrincipal: current },async proof=>{
      const identity=identityForProof(proof,'step_up');
      if (!sameAuthority(identity,current) || !isInternalUuid(proof.correlationId)) reject();
      const temporary=await sessionService.rotate(current,identity,{ purpose: 'step_up',correlationId: proof.correlationId });
      const temporaryPrincipal=normalizePlatformPrincipal(temporary.principal);
      if (temporaryPrincipal.assurance.level!=='step_up' || temporaryPrincipal.assurance.authenticationContext!==FRESH
        || !sameAuthority(temporaryPrincipal,identity) || temporaryPrincipal.assurance.authenticatedAt!==identity.assurance.authenticatedAt
        || temporaryPrincipal.session.securityEpoch!==securityEpoch || temporaryPrincipal.session.id===current.session.id) reject();
      const normalIdentity=identityForProof(proof,'mfa');
      const future=requiresContinuation ? await sessionService.issue(normalIdentity,{ correlationId: proof.correlationId }) : null;
      let continuationPrincipal=null;
      if (future) {
        continuationPrincipal=ordinary(future.principal,securityEpoch);
        if ([current.session.id,temporaryPrincipal.session.id].includes(continuationPrincipal.session.id)
          || !sameAuthority(continuationPrincipal,identity)
          || continuationPrincipal.assurance.authenticatedAt!==identity.assurance.authenticatedAt
          || ['provider','tenantReference','subjectReference'].some(key=>
            continuationPrincipal.providerIdentity[key]!==identity.providerIdentity[key])
          || continuationPrincipal.roles.join(',')!==identity.roles.join(',')
          || continuationPrincipal.targetScope.mode!==identity.targetScope.mode) reject();
      }
      const context=Object.freeze({});
      contexts.set(context,Object.freeze({ principal: temporaryPrincipal,continuationPrincipal,operationHash: input.operationHash }));
      let result;
      try { result=await mutation(context); } finally { contexts.delete(context); }
      if (result===undefined || result===null) reject();
      if (await sessionService.revoke(temporaryPrincipal,{ correlationId: proof.correlationId })!==true) reject();
      const issued=future ?? await sessionService.issue(normalIdentity,{ correlationId: proof.correlationId });
      const principal=ordinary(issued.principal,securityEpoch);
      if (!sameAuthority(principal,identity)
        || principal.assurance.authenticatedAt!==identity.assurance.authenticatedAt
        || [current.session.id,temporaryPrincipal.session.id].includes(principal.session.id)) reject();
      return Object.freeze({ result,issued });
    });
    if (!completed?.issued) reject();
    return Object.freeze({ status: 'operation_completed',result: completed.result,principal: completed.issued.principal,
      csrfToken: completed.issued.csrfToken,
      setCookies: Object.freeze([completed.issued.setCookie,clearPlatformMicrosoftOperationCookie()]) });
  }
  return Object.freeze({
    async startStepUp(value,{ operationHash,correlationId=idFactory() }={}) {
      const principal=ordinary(value,securityEpoch),state=tokenFactory(),id=idFactory();
      if (!HASH.test(operationHash || '') || !isOpaqueBrowserToken(state) || !isInternalUuid(id)
        || !isInternalUuid(correlationId)) reject();
      const cookie=`${state}.${browser(state)}`,lookup=locate(cookie,state);
      const created=await repository.create({ ...lookup,id,nonceHash: createHash('sha256').update(nonce(state)).digest('hex'),
        operationHash,correlationId,expectedPrincipal: principal,ttlSeconds: TTL_SECONDS });
      if (created!==true) reject();
      let authorizationUrl;
      try { authorizationUrl=await entraClient.authorizationUrl({ state,nonce: nonce(state),
        codeChallenge: createHash('sha256').update(mac('pkce',state,'base64url'),'ascii').digest('base64url'),
        authenticationContext: FRESH }); }
      catch { await repository.reject(lookup);reject(); }
      return Object.freeze({ status: 'microsoft_required',state,authorizationUrl,
        setCookies: Object.freeze([serializePlatformMicrosoftOperationBrowserCookie(cookie),
          serializePlatformMicrosoftOperationCookie(cookie,TTL_SECONDS)]) });
    },
    async pendingStatus({ state,cookie,request }={}) {
      const lookup=locate(cookie,state),record=await repository.findPending(lookup);
      if (!['pending','verified'].includes(record?.status)) reject();
      pending(record,record.status);await requireCurrentSource(record,request);
      // Read-only, source/browser-bound status. No proof, cookie, provider
      // identity or authority is returned; final exact request still consumes.
      return Object.freeze({ status: record.status });
    },
    async complete({ state,cookie,code,providerError=null }={}) {
      const lookup=locate(cookie,state),record=pending(await repository.findPending(lookup),'pending');
      if (providerError!==null) {
        if (code!==undefined || typeof providerError!=='string' || !/^[a-z][a-z0-9_]{1,63}$/.test(providerError)) reject();
        reportRejection('provider');await repository.reject(lookup);
        return Object.freeze({ status: 'authentication_rejected',setCookies: Object.freeze([
          clearPlatformMicrosoftOperationBrowserCookie(),clearPlatformMicrosoftOperationCookie()]) });
      }
      let stage='redemption';
      try {
        if (typeof code!=='string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code)) reject();
        const assertion=await entraClient.redeemAuthorizationCode({ code,codeVerifier: mac('pkce',state,'base64url'),
          expectedNonce: nonce(state),expectedNonceHash: record.nonceHash,authenticationContext: FRESH });
        stage='assertion';const verified=await entraClient.verify(assertion);
        stage='claims';const identity=claimPolicy.normalize(verified);
        stage='identity_binding';
        if (identity.provider!==PLATFORM_ENTRA_PROVIDER || identity.tenantReference!==record.providerIdentity.tenantReference
          || identity.subjectReference!==record.providerIdentity.subjectReference || identity.assurance.level!=='step_up'
          || identity.assurance.authenticationContext!==FRESH || instant(identity.assurance.authenticatedAt)<instant(record.createdAt)-60000
          || instant(identity.assurance.authenticatedAt)>clock()+60000) reject();
        stage='repository';if (await repository.verify({ ...lookup,id: record.id,identity })!==true) reject();
        stage='remaining_lifetime';const remaining=Math.min(TTL_SECONDS,Math.ceil((instant(record.expiresAt)-clock())/1000));
        if (remaining<1) reject();
        return Object.freeze({ status: 'operation_verified',setCookies: Object.freeze([
          clearPlatformMicrosoftOperationBrowserCookie(),serializePlatformMicrosoftOperationCookie(cookie,remaining)]) });
      } catch (error) { reportRejection(stage,error);await repository.reject(lookup);reject(); }
    },
    executeStepUp: (input,mutation)=>finish(input,mutation,false),
    executeStepUpWithContinuation: (input,mutation)=>finish(input,mutation,true),
    verifiedOperationPrincipal(context,operationHash) { return verifiedContext(context,operationHash).principal; },
    verifiedOperationWithContinuation(context,operationHash) { return verifiedContext(context,operationHash,true); },
  });
}

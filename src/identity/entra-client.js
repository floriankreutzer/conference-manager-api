import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { normalizeAttributionSourceDisplayName } from '../domain/request-attribution.js';
import { createBoundedMicrosoftIdentityNetworkClient } from '../integrations/microsoft365-client.js';
import { customerMicrosoftEndpoints,normalizeFreshCustomerMicrosoftUrl } from './customer-microsoft-authorization-url.js';
import { EntraAuthenticationError } from './entra-errors.js';

const ENTRA_PROVIDER = 'microsoft_entra';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OIDC_SCOPES = Object.freeze(['openid', 'profile']);

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureHashMatch(value, expectedHash) {
  if (typeof value !== 'string' || typeof expectedHash!=='string' || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(sha256Hex(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireGuid(value, code) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) throw new EntraAuthenticationError(code);
  return value.toLowerCase();
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') return null;
  try {
    return normalizeAttributionSourceDisplayName(value);
  } catch {
    return null;
  }
}

function validateAuthorizationUrl(value, authority) {
  let parsed;
  let expected;
  try {
    parsed = new URL(value);
    expected = new URL(authority);
  } catch {
    throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_URL_INVALID');
  }
  const authorityPath = expected.pathname.replace(/\/$/, '');
  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== expected.origin
    || parsed.pathname !== `${authorityPath}/oauth2/v2.0/authorize`
  ) {
    throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_URL_INVALID');
  }
  return parsed.toString();
}

function validateIdTokenClaims(claims, {
  clientId,
  authority,
  expectedNonceHash,
  clock,
}) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new EntraAuthenticationError('ENTRA_ID_TOKEN_CLAIMS_INVALID');
  }

  const tenantReference = requireGuid(claims.tid, 'ENTRA_TENANT_CLAIM_INVALID');
  const userReference = requireGuid(claims.oid, 'ENTRA_USER_CLAIM_INVALID');
  if (claims.aud !== clientId) throw new EntraAuthenticationError('ENTRA_AUDIENCE_INVALID');

  const authorityUrl = new URL(authority);
  const expectedIssuer = `${authorityUrl.origin}/${tenantReference}/v2.0`;
  if (claims.iss !== expectedIssuer) throw new EntraAuthenticationError('ENTRA_ISSUER_INVALID');
  if (!secureHashMatch(claims.nonce, expectedNonceHash)) {
    throw new EntraAuthenticationError('ENTRA_NONCE_INVALID');
  }

  const nowSeconds = Math.floor(clock() / 1000);
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
    throw new EntraAuthenticationError('ENTRA_TOKEN_EXPIRED');
  }
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + 300)) {
    throw new EntraAuthenticationError('ENTRA_TOKEN_NOT_YET_VALID');
  }
  if (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + 300)) {
    throw new EntraAuthenticationError('ENTRA_TOKEN_ISSUED_AT_INVALID');
  }
  if (claims.ver !== undefined && claims.ver !== '2.0') {
    throw new EntraAuthenticationError('ENTRA_TOKEN_VERSION_INVALID');
  }

  return Object.freeze({
    provider: ENTRA_PROVIDER,
    tenantReference,
    userReference,
    displayName: normalizeDisplayName(claims.name),
  });
}

export function createEntraClient({
  clientId,
  clientSecret,
  authority,
  redirectUri,
  clock = () => Date.now(),
  application,
} = {}) {
  if (!GUID_PATTERN.test(clientId || '')) throw new TypeError('ENTRA_CLIENT_ID_INVALID');
  if (typeof clientSecret !== 'string' || clientSecret.length < 1) throw new TypeError('ENTRA_CLIENT_SECRET_REQUIRED');
  if (typeof authority !== 'string' || typeof redirectUri !== 'string') throw new TypeError('ENTRA_ENDPOINT_CONFIGURATION_REQUIRED');

  const msal = application || new ConfidentialClientApplication({
    auth: {
      clientId,
      authority,
      clientSecret,
    },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
  if (typeof msal.getAuthCodeUrl !== 'function' || typeof msal.acquireTokenByCode !== 'function') {
    throw new TypeError('ENTRA_APPLICATION_INVALID');
  }

  return Object.freeze({
    async authorizationUrl({ state, nonce, codeChallenge }) {
      try {
        const value = await msal.getAuthCodeUrl({
          scopes: OIDC_SCOPES,
          redirectUri,
          responseMode: 'query',
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: 'S256',
        });
        return validateAuthorizationUrl(value, authority);
      } catch (error) {
        if (error instanceof EntraAuthenticationError) throw error;
        throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_START_FAILED');
      }
    },

    async redeemAuthorizationCode({ code, codeVerifier, expectedNonce, expectedNonceHash }) {
      if (typeof expectedNonce!=='string' || expectedNonce.length<1 || expectedNonce.length>512
        || !secureHashMatch(expectedNonce,expectedNonceHash)) throw new EntraAuthenticationError('ENTRA_NONCE_INVALID');
      let result;
      try {
        result = await msal.acquireTokenByCode({
          code,
          scopes: OIDC_SCOPES,
          redirectUri,
          codeVerifier,
          nonce: expectedNonce,
        });
      } catch {
        throw new EntraAuthenticationError('ENTRA_CODE_REDEMPTION_FAILED');
      }
      return validateIdTokenClaims(result?.idTokenClaims, {
        clientId,
        authority,
        expectedNonceHash,
        clock,
      });
    },
  });
}

export const ENTRA_IDENTITY_PROVIDER = ENTRA_PROVIDER;


function exactFreshInput(value,fields) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new EntraAuthenticationError('ENTRA_FRESH_INPUT_INVALID');
  const keys=Reflect.ownKeys(value);
  if (keys.length!==fields.length || keys.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !fields.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) throw new EntraAuthenticationError('ENTRA_FRESH_INPUT_INVALID');
}
async function beforeMicrosoftDeadline(work,signal) {
  let aborted;
  try {
    return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{
      aborted=()=>reject(new EntraAuthenticationError('ENTRA_FRESH_PROVIDER_UNAVAILABLE'));
      if (signal.aborted) aborted();else signal.addEventListener('abort',aborted,{ once: true });
    })]);
  } finally { if (aborted) signal.removeEventListener('abort',aborted); }
}
// Fresh organizational primary proof only, not membership, account linking, MFA
// or a business session. Legacy createEntraClient semantics are unchanged.
export function createFreshCustomerEntraClient({ clientId,clientSecret,authority,publicOrigin,
  clock=()=>Date.now(),fetchImpl=globalThis.fetch,applicationFactory,timeoutMs=10000 } = {}) {
  if (!GUID_PATTERN.test(clientId ?? '') || typeof clientSecret!=='string'
    || Buffer.byteLength(clientSecret)<32 || Buffer.byteLength(clientSecret)>512
    || clientSecret.trim()!==clientSecret || /[\u0000-\u001f\u007f]/.test(clientSecret)
    || typeof clock!=='function' || typeof fetchImpl!=='function'
    || (applicationFactory!==undefined && typeof applicationFactory!=='function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>15000) {
    throw new TypeError('ENTRA_FRESH_CLIENT_CONFIGURATION_INVALID');
  }
  const endpoints=customerMicrosoftEndpoints({ clientId: clientId.toLowerCase(),authority,publicOrigin }),proofs=new WeakMap();
  function now() {
    const value=clock();if (!Number.isSafeInteger(value) || value<0) throw new EntraAuthenticationError('ENTRA_FRESH_CLOCK_INVALID');
    return value;
  }
  function application(signal,redemption=null) {
    const restrictedFetch=(value,options)=>{
      if (options.method!=='POST') return fetchImpl(value,options);
      const url=new URL(value),form=new URLSearchParams(options.body);
      const expected=redemption && { client_id: endpoints.clientId,client_secret: clientSecret,
        grant_type: 'authorization_code',code: redemption.code,code_verifier: redemption.codeVerifier,
        redirect_uri: endpoints.redirectUri };
      if (!expected || url.pathname!=='/organizations/oauth2/v2.0/token'
        || [...form.keys()].some(key=>form.getAll(key).length!==1)
        || Object.entries(expected).some(([key,entry])=>form.get(key)!==entry)) {
        throw new EntraAuthenticationError('ENTRA_FRESH_PROVIDER_REQUEST_INVALID');
      }
      const scopes=(form.get('scope') ?? '').split(' ').filter(Boolean);
      if (new Set(scopes).size!==scopes.length || ![2,3].includes(scopes.length)
        || !['openid','profile'].every(scope=>scopes.includes(scope))
        || scopes.some(scope=>!['openid','profile','offline_access'].includes(scope))) {
        throw new EntraAuthenticationError('ENTRA_FRESH_PROVIDER_REQUEST_INVALID');
      }
      // The SDK adds its offline default again at token redemption. The code is
      // exchanged only for the same two OIDC scopes authorized by this adapter.
      form.set('scope','openid profile');
      return fetchImpl(value,{ ...options,body: form.toString() });
    };
    const configuration={ auth: { clientId: endpoints.clientId,clientSecret,authority: endpoints.authority },system: {
      networkClient: createBoundedMicrosoftIdentityNetworkClient({ fetchImpl: restrictedFetch,timeoutMs,totalDeadlineSignal: signal }),
      loggerOptions: { piiLoggingEnabled: false,loggerCallback: ()=>{} },
    } };
    const value=applicationFactory ? applicationFactory(configuration) : new ConfidentialClientApplication(configuration);
    if (typeof value?.getAuthCodeUrl!=='function' || typeof value?.acquireTokenByCode!=='function') {
      throw new TypeError('ENTRA_FRESH_APPLICATION_INVALID');
    }
    return value;
  }
  return Object.freeze({
    async authorizationUrl(input) {
      exactFreshInput(input,['state','nonce','codeChallenge']);
      // Validate caller-generated proofs before any SDK/provider work.
      if (![input.state,input.nonce,input.codeChallenge].every(value=>typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value))) {
        throw new EntraAuthenticationError('ENTRA_FRESH_INPUT_INVALID');
      }
      const signal=AbortSignal.timeout(timeoutMs);
      try {
        const app=application(signal),value=await beforeMicrosoftDeadline(()=>app.getAuthCodeUrl({
          scopes: OIDC_SCOPES,redirectUri: endpoints.redirectUri,responseMode: 'query',responseType: 'code',
          ...input,codeChallengeMethod: 'S256',prompt: 'login',extraQueryParameters: { max_age: '0' },
          claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }),
        }),signal);
        return normalizeFreshCustomerMicrosoftUrl(value,endpoints,input);
      } catch (error) {
        if (error instanceof EntraAuthenticationError) throw error;
        throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_START_FAILED');
      }
    },
    async redeemAuthorizationCode(input) {
      exactFreshInput(input,['code','codeVerifier','expectedNonce','expectedNonceHash','startedAt']);
      const { code,codeVerifier,expectedNonce,expectedNonceHash,startedAt }=input;
      const started=typeof startedAt==='string' ? Date.parse(startedAt) : NaN,time=now();
      if (typeof code!=='string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code)
        || typeof codeVerifier!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(codeVerifier)
        || typeof expectedNonce!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedNonce)
        || typeof expectedNonceHash!=='string' || !/^[a-f0-9]{64}$/.test(expectedNonceHash)
        || !secureHashMatch(expectedNonce,expectedNonceHash)
        || typeof startedAt!=='string' || !Number.isFinite(started) || new Date(started).toISOString()!==startedAt
        || started>time+60000 || started<time-900000) throw new EntraAuthenticationError('ENTRA_FRESH_INPUT_INVALID');
      const signal=AbortSignal.timeout(timeoutMs);let result;
      try {
        const app=application(signal,{ code,codeVerifier });result=await beforeMicrosoftDeadline(()=>app.acquireTokenByCode({
          code,codeVerifier,nonce: expectedNonce,scopes: OIDC_SCOPES,redirectUri: endpoints.redirectUri,
        }),signal);
      } catch { throw new EntraAuthenticationError('ENTRA_CODE_REDEMPTION_FAILED'); }
      const verifiedAt=now(),claims=result?.idTokenClaims;
      const identity=validateIdTokenClaims(claims,{ clientId: endpoints.clientId,authority: endpoints.authority,
        expectedNonceHash,clock: ()=>verifiedAt });
      const seconds=Math.floor(verifiedAt/1000),auth=claims.auth_time;
      if (identity.tenantReference==='9188040d-6c67-4c5b-b112-36a304b66dad' || claims.ver!=='2.0'
        || !Number.isSafeInteger(auth) || auth<0 || auth>seconds+60 || auth<seconds-360 || auth<Math.floor(started/1000)-60
        || !Number.isSafeInteger(claims.iat) || claims.iat<auth-60 || claims.iat>seconds+60 || claims.exp<=claims.iat
        || (claims.nbf!==undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf>seconds+60))) {
        throw new EntraAuthenticationError('ENTRA_FRESH_AUTHENTICATION_INVALID');
      }
      const assertion=Object.freeze(Object.create(null));
      proofs.set(assertion,{ nonceHash: expectedNonceHash,verifiedAt,expiresAt: Math.min(claims.exp*1000,verifiedAt+300000),
        identity: Object.freeze({ provider: identity.provider,tenantReference: identity.tenantReference,
          userReference: identity.userReference,
          authenticatedAt: new Date(auth*1000).toISOString() }) });
      return assertion;
    },
    async verifyPrimary(assertion,input) {
      exactFreshInput(input,['expectedNonceHash']);
      const proof=assertion && proofs.get(assertion);if (assertion) proofs.delete(assertion);
      if (!proof || typeof input.expectedNonceHash!=='string' || !/^[a-f0-9]{64}$/.test(input.expectedNonceHash)
        || !timingSafeEqual(Buffer.from(proof.nonceHash,'hex'),Buffer.from(input.expectedNonceHash,'hex'))) {
        throw new EntraAuthenticationError('ENTRA_FRESH_ASSERTION_NOT_VERIFIED');
      }
      const time=now();
      if (time>=proof.expiresAt || time<proof.verifiedAt-60000
        || Date.parse(proof.identity.authenticatedAt)<time-360000) throw new EntraAuthenticationError('ENTRA_FRESH_ASSERTION_EXPIRED');
      return proof.identity;
    },
  });
}

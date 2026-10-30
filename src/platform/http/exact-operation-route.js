import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { readPlatformMicrosoftOperationCookie,readPlatformMicrosoftOperationBrowserCookie,
  clearPlatformMicrosoftOperationCookie,PLATFORM_MICROSOFT_OPERATION_CALLBACK } from '../identity/microsoft-operation-cookie.js';
import { readPlatformPasskeyTransactionCookie, clearPlatformPasskeyTransactionCookie } from '../identity/passkey-auth-cookie.js';
import { readPlatformPasskeyOperationCookie, serializePlatformPasskeyOperationCookie,
  clearPlatformPasskeyOperationCookie } from '../identity/passkey-operation-cookie.js';
import { definePlatformRouteModule } from './route-module.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE as ROUTE } from './observability.js';
import { requirePlatformCookie,requirePlatformProviderAuthorizationUrl,sendPlatformJson } from './response.js';
import { assertNoPlatformRequestBody, readPlatformJsonObject, requirePlatformExactObject } from './security.js';

const METHODS = new Map([
  [ROUTE.INVITATION_LIST, 'GET'], [ROUTE.INVITATION_ISSUE, 'POST'],
  [ROUTE.TENANT_CREATE, 'POST'], [ROUTE.INVITATION_REVOKE, 'DELETE'], [ROUTE.INVITATION_REISSUE, 'POST'],
  [ROUTE.LIFECYCLE_TRANSITION, 'POST'], [ROUTE.ENTITLEMENT_PREVIEW, 'POST'], [ROUTE.ENTITLEMENT_APPLY, 'POST'],
  [ROUTE.PACKAGE_APPLY, 'POST'], [ROUTE.QUOTA_SET, 'POST'], [ROUTE.AUDIT_EXPORTS, 'GET'],
  [ROUTE.DIAGNOSTIC_CORRELATION, 'GET'],
  [ROUTE.RECOVERY_TARGETS, 'GET'],
  ...['LAST_ADMIN','MICROSOFT','MAPPING','IDENTITY','TENANT_SESSIONS','USER_SESSIONS','SUSPEND','REACTIVATE']
    .flatMap(name => ['PREVIEW','EXECUTE'].map(stage => [ROUTE[`RECOVERY_${name}_${stage}`], 'POST'])),
]);
function denied() { throw new PlatformHttpError(403, 'PLATFORM_PASSKEY_OPERATION_REJECTED', { securityCategory: 'authorization' }); }
function canonical(value, depth = 0, count = { n: 0 },deny=denied) {
  if (++count.n > 2048 || depth > 8) deny();
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return value;
  if (typeof value === 'string' && value.length <= 4096) return value;
  if (Array.isArray(value) && value.length <= 128) return value.map(item => canonical(item, depth + 1, count,deny));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort(); if (keys.length > 128) deny();
    const result = Object.create(null);
    for (const key of keys) {
      if (key.length > 128 || ['__proto__','constructor','prototype'].includes(key)) deny();
      result[key] = canonical(value[key], depth + 1, count,deny);
    }
    return result;
  }
  deny();
}
function proofHeader(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(value)) denied();
  const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) denied();
  let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { denied(); }
  requirePlatformExactObject(result, { required: {
    state: candidate => typeof candidate === 'string' && /^[A-Za-z0-9_-]{43}$/.test(candidate),
    response: candidate => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
  } });
  return result;
}
function bufferedResponse(maximum) {
  const headers = new Map(); let body = null;
  const response = { statusCode: 200,
    setHeader(name, value) {
      const key = name.toLowerCase();
      if (!['content-type','content-length'].includes(key) || headers.has(key)) throw new Error('PLATFORM_OPERATION_RESPONSE_INVALID');
      headers.set(key, value);
    },
    end(value) {
      if (body !== null || typeof value !== 'string' || Buffer.byteLength(value) > maximum) {
        throw new Error('PLATFORM_OPERATION_RESPONSE_INVALID');
      }
      body = value;
    },
  };
  return { response, result() {
    if (body === null || !Number.isSafeInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300
      || headers.get('content-type') !== 'application/json; charset=utf-8'
      || headers.get('content-length') !== Buffer.byteLength(body)) throw new Error('PLATFORM_OPERATION_RESPONSE_INVALID');
    let payload; try { payload = JSON.parse(body); } catch { throw new Error('PLATFORM_OPERATION_RESPONSE_INVALID'); }
    return Object.freeze({ statusCode: response.statusCode, payload });
  } };
}

// Decorates existing concrete route families, never a generic command endpoint.
// Existing body validation, role/target policy, idempotency and use cases still
// execute once; only their current request can consume the opaque proof context.
export function protectPlatformExactOperationRoute(module, { authService,environment,securityEpoch,mode }={}) {
  const microsoft=mode==='microsoft_mfa';
  if (!['application_passkey','microsoft_mfa'].includes(mode)) throw new TypeError('PLATFORM_OPERATION_MODE_INVALID');
  const deny=()=>{
    if (!microsoft) denied();
    throw new PlatformHttpError(403,'PLATFORM_MICROSOFT_OPERATION_REJECTED',{ securityCategory: 'authorization' });
  };
  if (!['startStepUp','executeStepUp','verifiedOperationPrincipal'].every(name => typeof authService?.[name] === 'function')
    || !['dev','int','prod'].includes(environment) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
    throw new TypeError('PLATFORM_PASSKEY_OPERATION_CONFIGURATION_INVALID');
  }
  return definePlatformRouteModule({ id: module.id, claim: module.claim,
    createHandler(runtime) {
      const authorities = new WeakMap();
      const handler = module.createHandler({ ...runtime, platformPrincipalGuard: {
        ...runtime.platformPrincipalGuard,
        async require(request, options) {
          const authority = authorities.get(request); if (!authority) return runtime.platformPrincipalGuard.require(request, options);
          authorities.delete(request);
          return normalizePlatformPrincipal(authService.verifiedOperationPrincipal(authority.context, authority.operationHash));
        },
      } });
      return async context => {
        const { request, response, parsedUrl, path, requestId } = context;
        const route = module.claim({ ...context, method: request.method });
        if (!route || METHODS.get(route) !== request.method) return handler(context);
        const principal = await runtime.platformPrincipalGuard.require(request, { csrf: true, correlationId: requestId });
        if (principal.session.securityEpoch !== securityEpoch
          || principal.assurance.authenticationContext !== (microsoft ? 'cm:ms:mfa:v1' : 'cm:pk:v1')) deny();
        let body = null;
        if (request.method === 'GET') await assertNoPlatformRequestBody(request);
        else body = canonical(await readPlatformJsonObject(request, { maxBytes: Math.min(runtime.maxBodyBytes, 32768) }),0,{ n: 0 },deny);
        const idempotencyKey = request.headers['idempotency-key'] ?? null;
        if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 36)) denied();
        const target = `${path}${parsedUrl.search}`; if (target.length > 4096) denied();
        const operationHash = createHash('sha256').update(JSON.stringify(['platform-operation-proof:v1', environment, securityEpoch,
          principal.operatorId, principal.securityVersion, principal.session.id, request.method, target, idempotencyKey, body]))
          .digest('hex');
        if (microsoft && request.headers['x-platform-passkey-proof']!==undefined) deny();
        const supplied=request.headers[microsoft ? 'x-platform-microsoft-proof' : 'x-platform-passkey-proof'];
        if (microsoft && supplied!==undefined && !isOpaqueBrowserToken(supplied)) deny();
        const proof=microsoft ? supplied===undefined ? null : { state: supplied } : proofHeader(supplied);
        if (!proof) {
          const started = await authService.startStepUp(principal, { operationHash, correlationId: requestId });
          if (microsoft) {
            if (started?.status!=='microsoft_required' || !isOpaqueBrowserToken(started.state)
              || !Array.isArray(started.setCookies) || started.setCookies.length!==2) {
              throw new Error('PLATFORM_OPERATION_PROOF_RESULT_INVALID');
            }
            const first=requirePlatformCookie(started.setCookies[0],{ name: 'cm_platform_ms_operation_tx',
              path: PLATFORM_MICROSOFT_OPERATION_CALLBACK,sameSite: 'Lax' });
            const second=requirePlatformCookie(started.setCookies[1],{ name: 'cm_platform_ms_operation',
              path: '/api/v1/platform',sameSite: 'Strict' });
            const callbackCookie=readPlatformMicrosoftOperationBrowserCookie({ cookie: first.split(';')[0] });
            if (!callbackCookie || callbackCookie.split('.')[0]!==started.state
              || readPlatformMicrosoftOperationCookie({ cookie: second.split(';')[0] })!==callbackCookie) {
              throw new Error('PLATFORM_OPERATION_PROOF_RESULT_INVALID');
            }
            const authorizationUrl=requirePlatformProviderAuthorizationUrl(started.authorizationUrl,runtime.platformEntraAuthority,{
              clientId: runtime.platformEntraClientId,redirectUri: runtime.platformPublicOrigin+PLATFORM_MICROSOFT_OPERATION_CALLBACK,
              authenticationContext: 'cm:ms:fresh:v1',authenticationMaxAgeSeconds: 300,
              expectedPrompt: 'login',
            });
            if (new URL(authorizationUrl).searchParams.get('state')!==started.state) {
              throw new Error('PLATFORM_OPERATION_PROOF_RESULT_INVALID');
            }
            response.setHeader('Set-Cookie',[first,second]);
            sendPlatformJson(response,428,{ status: started.status,state: started.state,authorizationUrl,requestId },
              runtime.maxResponseBytes);return 428;
          }
          if (started?.status !== 'passkey_required') throw new Error('PLATFORM_OPERATION_PROOF_RESULT_INVALID');
          const pendingCookie = readPlatformPasskeyTransactionCookie({ cookie: started.setCookie?.split(';')[0] });
          if (!pendingCookie || pendingCookie.split('.')[0] !== started.state) throw new Error('PLATFORM_OPERATION_PROOF_RESULT_INVALID');
          response.setHeader('Set-Cookie', serializePlatformPasskeyOperationCookie(pendingCookie));
          sendPlatformJson(response, 428, { status: started.status, state: started.state, options: started.options, requestId },
            runtime.maxResponseBytes); return 428;
        }
        try {
          const completed = await authService.executeStepUp({ ...proof, operationHash, request,
            cookie: microsoft ? readPlatformMicrosoftOperationCookie(request.headers)
              : readPlatformPasskeyOperationCookie(request.headers) }, async verifiedContext => {
            const serialized = body === null ? null : JSON.stringify(body);
            const internal = Readable.from(serialized === null ? [] : [Buffer.from(serialized)]);
            internal.method = request.method;
            internal.headers = { ...(serialized === null ? {} : { 'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(serialized)) }),
              ...(idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey }) };
            authorities.set(internal, { context: verifiedContext, operationHash });
            const buffered = bufferedResponse(runtime.maxResponseBytes);
            try {
              const status = await handler({ ...context, request: internal, response: buffered.response });
              const result = buffered.result();
              if (status !== result.statusCode || authorities.has(internal)) throw new Error('PLATFORM_OPERATION_RESPONSE_INVALID');
              return result;
            } finally { authorities.delete(internal); internal.destroy(); }
          });
          if (completed?.status !== 'operation_completed' || completed.principal?.assurance?.level !== 'mfa'
            || !Array.isArray(completed.setCookies) || completed.setCookies.length !== 2
            || completed.setCookies[1] !== (microsoft ? clearPlatformMicrosoftOperationCookie()
              : clearPlatformPasskeyTransactionCookie())) {
            throw new Error('PLATFORM_OPERATION_PROOF_RESULT_INVALID');
          }
          const cookie = requirePlatformCookie(completed.setCookies[0],
            { name: 'cm_platform_session', path: '/api/v1/platform', sameSite: 'Strict' });
          // Emit the business outcome only after proof, writes, audit and ordinary
          // session issuance have committed. No strong cookie leaves the server.
          response.setHeader('Set-Cookie',[cookie,microsoft ? clearPlatformMicrosoftOperationCookie()
            : clearPlatformPasskeyOperationCookie()]);
          sendPlatformJson(response, completed.result.statusCode, completed.result.payload, runtime.maxResponseBytes);
          return completed.result.statusCode;
        } catch (failure) {
          if (failure?.name !== 'PlatformIdentityError' && failure?.name !== 'PlatformPasskeyError') throw failure;
          await runtime.platformAuditService.record(runtime.platformAuditService.createDeniedEvent({ principal,
            action: 'platform.authorization.denied',targetId: 'request',
            targetType: microsoft ? 'platform_microsoft_operation' : 'platform_passkey_operation',
            metadata: { reasonCode: microsoft ? 'microsoft_operation_rejected' : 'passkey_rejected' }, correlationId: requestId }));
          deny();
        }
      };
    },
  });
}

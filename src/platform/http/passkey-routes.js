import { timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { readPlatformPasskeyTransactionCookie, clearPlatformPasskeyTransactionCookie } from '../identity/passkey-auth-cookie.js';
import { readPlatformPasskeyEnrollmentCookie, serializePlatformPasskeyEnrollmentCookie,
  clearPlatformPasskeyEnrollmentCookie } from '../identity/passkey-enrollment-cookie.js';
import { serializeClearedPlatformSessionCookie } from '../identity/session-cookie.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE as ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import { requirePlatformCookie, sendPlatformJson } from './response.js';
import { assertNoPlatformRequestBody, assertPlatformNoQuery, createPlatformRateLimiter,
  readPlatformJsonObject, requirePlatformExactObject } from './security.js';

const BASE = '/api/v1/platform/auth/passkey';
const ROUTES = new Map([
  [`${BASE}/configuration`, ['GET',ROUTE.PASSKEY_CONFIGURATION,'configuration']],
  [`${BASE}/pending`, ['GET',ROUTE.PASSKEY_PENDING,'pending']],
  [`${BASE}/authenticate`, ['POST',ROUTE.PASSKEY_AUTHENTICATE,'authenticate']],
  [`${BASE}/enrollment/pending`, ['GET',ROUTE.PASSKEY_ENROLLMENT_PENDING,'enrollment_pending']],
  [`${BASE}/enrollment/start`, ['POST',ROUTE.PASSKEY_ENROLLMENT_START,'enrollment_start']],
  [`${BASE}/enrollment/register`, ['POST',ROUTE.PASSKEY_REGISTER,'register']],
  [`${BASE}/enrollment/complete`, ['POST',ROUTE.PASSKEY_ENROLLMENT_COMPLETE,'enrollment_complete']],
  [`${BASE}/manage/keys`, ['GET',ROUTE.PASSKEY_OWN_KEYS,'keys']],
  [`${BASE}/manage/addition/start`, ['POST',ROUTE.PASSKEY_ADDITION_START,'addition_start']],
  [`${BASE}/manage/addition/complete`, ['POST',ROUTE.PASSKEY_ADDITION_COMPLETE,'addition_complete']],
  [`${BASE}/manage/revocation/start`, ['POST',ROUTE.PASSKEY_REVOCATION_START,'revocation_start']],
  [`${BASE}/manage/revocation/complete`, ['POST',ROUTE.PASSKEY_REVOCATION_COMPLETE,'revocation_complete']],
]);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1366 && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function grantToken(value) { return opaque(value) && Buffer.from(value, 'base64url').toString('base64url') === value; }
function invalidResult() { throw new PlatformHttpError(500, 'PLATFORM_PASSKEY_SERVICE_RESULT_INVALID'); }
function instant(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function ownKeys(value) {
  if (!Array.isArray(value?.items) || value.items.length > 5 || new Set(value.items.map(item => item?.id)).size !== value.items.length) {
    invalidResult();
  }
  return value.items.map(item => {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'backedUp,backupEligible,createdAt,id,lastUsedAt'
      || !identifier(item.id) || !instant(item.createdAt) || (item.lastUsedAt !== null && !instant(item.lastUsedAt))
      || typeof item.backupEligible !== 'boolean' || typeof item.backedUp !== 'boolean' || (item.backedUp && !item.backupEligible)) {
      invalidResult();
    }
    return { id: item.id, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt,
      backupEligible: item.backupEligible, backedUp: item.backedUp };
  });
}
function enrollmentCookie(result) {
  if (result?.status !== 'registration_required' || !opaque(result.state) || !object(result.options)
    || typeof result.setCookie !== 'string') invalidResult();
  const value = readPlatformPasskeyEnrollmentCookie({ cookie: result.setCookie.split(';')[0] });
  if (!value || value.split('.')[0] !== result.state || result.setCookie !== serializePlatformPasskeyEnrollmentCookie(value, 120)) {
    invalidResult();
  }
  return result.setCookie;
}
function sessionCookies(result) {
  if (!Array.isArray(result?.setCookies) || result.setCookies.length !== 2 || result.principal?.assurance?.level !== 'mfa'
    || !opaque(result.csrfToken)) invalidResult();
  const session = requirePlatformCookie(result.setCookies[0],
    { name: 'cm_platform_session', path: '/api/v1/platform', sameSite: 'Strict' });
  if (result.setCookies[1] !== clearPlatformPasskeyTransactionCookie()) invalidResult();
  return [session, result.setCookies[1]];
}
function optionsResult(value, allowed) {
  if (!value || !allowed.includes(value.status) || !opaque(value.state) || !object(value.options)) invalidResult();
  return { status: value.status, state: value.state, options: value.options };
}
function preauthenticationCsrf(request, state) {
  const value = request.headers['x-csrf-token'];
  if (!opaque(value) || !timingSafeEqual(Buffer.from(value), Buffer.from(state))) {
    throw new PlatformHttpError(403, 'PLATFORM_CSRF_INVALID', { securityCategory: 'authorization' });
  }
}

export const platformPasskeyRoutes = definePlatformRouteModule({
  id: 'platform-passkey',
  claim({ path }) { return ROUTES.get(path)?.[1] ?? null; },
  createHandler({ platformPasskeyService: service, platformPrincipalGuard, platformAuditService,
    maxBodyBytes, maxResponseBytes, platformClock = () => Date.now() }) {
    const methods = ['configuration','pendingAuthentication','authenticate','startEnrollment','pendingEnrollment','register',
      'completeEnrollment','listKeys','startAddition','completeAddition','startRevocation','completeRevocation'];
    if (!methods.every(name => typeof service?.[name] === 'function') || typeof platformPrincipalGuard?.require !== 'function'
      || !['record','createDeniedEvent','createUnmappedAuthenticationFailure']
        .every(name => typeof platformAuditService?.[name] === 'function')) {
      throw new TypeError('PLATFORM_PASSKEY_HTTP_PORTS_REQUIRED');
    }
    const limiter = createPlatformRateLimiter({ max: 30, windowMs: 60000, maxKeys: 10000, clock: platformClock });
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      const route = ROUTES.get(path);
      if (!route) return null;
      if (request.method !== route[0]) throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      assertPlatformNoQuery(parsedUrl);
      limiter.consume(request.socket.remoteAddress || 'unknown');
      const action = route[2]; const managed = path.startsWith(`${BASE}/manage/`);
      let principal = null;
      try {
        if (managed) principal = await platformPrincipalGuard.require(request,
          { csrf: request.method === 'POST', correlationId: requestId });
        let body = null;
        if (request.method === 'GET') await assertNoPlatformRequestBody(request);
        else body = await readPlatformJsonObject(request, { maxBytes: Math.min(maxBodyBytes, 32768) });
        const authCookie = readPlatformPasskeyTransactionCookie(request.headers);
        const enrollCookie = readPlatformPasskeyEnrollmentCookie(request.headers);
        let payload;
        if (action === 'configuration') {
          const value = service.configuration();
          if (!value || !['passkey_setup','application_passkey'].includes(value.mode)
            || !['dev','int','prod'].includes(value.environment) || value.minimumPasskeys !== 2) invalidResult();
          payload = { mode: value.mode, environment: value.environment, minimumPasskeys: 2 };
        } else if (action === 'pending' || action === 'enrollment_pending') {
          const value = action === 'pending' ? await service.pendingAuthentication(authCookie)
            : await service.pendingEnrollment(enrollCookie);
          if (value?.status === 'enrollment_required' && opaque(value.state)) payload = { status: value.status, state: value.state };
          else {
            payload = optionsResult(value, ['passkey_required','registration_required','possession_required']);
            if (action === 'pending') {
              if (typeof value.setupRequired !== 'boolean') invalidResult();
              payload.setupRequired = value.setupRequired;
            }
          }
        } else if (action === 'keys') {
          const value = await service.listKeys(request);
          payload = { items: ownKeys(value) };
        } else if (action === 'addition_start' || action === 'revocation_start') {
          requirePlatformExactObject(body, { required: action === 'revocation_start' ? { credentialId: identifier } : {} });
          const value = action === 'addition_start' ? await service.startAddition(principal)
            : await service.startRevocation(principal, body.credentialId);
          payload = optionsResult(value, ['passkey_required']);
          response.setHeader('Set-Cookie', requirePlatformCookie(value.setCookie,
            { name: 'cm_platform_passkey_tx', path: BASE, sameSite: 'Strict' }));
        } else {
          const required = action === 'enrollment_start' ? { state: opaque, grantId: isInternalUuid, token: grantToken }
            : { state: opaque, response: object, ...(action === 'revocation_complete' ? { credentialId: identifier } : {}) };
          requirePlatformExactObject(body, { required });
          if (!managed) preauthenticationCsrf(request, body.state);
          if (action === 'enrollment_start') {
            const value = await service.startEnrollment({ cookie: authCookie, state: body.state,
              grant: { grantId: body.grantId, token: body.token } });
            response.setHeader('Set-Cookie', [clearPlatformPasskeyTransactionCookie(), enrollmentCookie(value)]);
            payload = optionsResult(value, ['registration_required']);
          } else if (action === 'register') {
            payload = optionsResult(await service.register({ cookie: enrollCookie, ...body }), ['possession_required']);
          } else if (action === 'enrollment_complete') {
            const value = await service.completeEnrollment({ cookie: enrollCookie, ...body });
            if (value?.status !== 'credential_enrolled') invalidResult();
            response.setHeader('Set-Cookie', [clearPlatformPasskeyEnrollmentCookie(),
              serializeClearedPlatformSessionCookie({ secure: true })]);
            payload = { status: 'credential_enrolled' };
          } else if (action === 'revocation_complete') {
            const value = await service.completeRevocation({ cookie: authCookie, ...body, request });
            if (value?.status !== 'reauthentication_required' || value.result?.status !== 'credential_revoked') invalidResult();
            response.setHeader('Set-Cookie', [serializeClearedPlatformSessionCookie({ secure: true }),
              clearPlatformPasskeyTransactionCookie(), clearPlatformPasskeyEnrollmentCookie()]);
            payload = { status: 'reauthentication_required' };
          } else {
            const value = action === 'addition_complete' ? await service.completeAddition({ cookie: authCookie, ...body, request })
              : await service.authenticate({ cookie: authCookie, ...body });
            if (value?.status === 'authenticated') {
              if (service.configuration().mode !== 'application_passkey') invalidResult();
              response.setHeader('Set-Cookie', sessionCookies(value)); payload = { status: 'authenticated' };
            } else if (value?.status === 'setup_complete') {
              response.setHeader('Set-Cookie', clearPlatformPasskeyTransactionCookie()); payload = { status: 'setup_complete' };
            } else if (value?.status === 'operation_completed') {
              const registration = value.result;
              response.setHeader('Set-Cookie', [...sessionCookies(value), enrollmentCookie(registration)]);
              payload = optionsResult(registration, ['registration_required']);
            } else {
              response.setHeader('Set-Cookie', [clearPlatformPasskeyTransactionCookie(), enrollmentCookie(value)]);
              payload = optionsResult(value, ['registration_required']);
            }
          }
        }
        sendPlatformJson(response, 200, { ...payload, requestId }, maxResponseBytes); return 200;
      } catch (error) {
        if (!['PlatformIdentityError','PlatformPasskeyError'].includes(error?.name)) throw error;
        if (request.method === 'POST') {
          const event = principal ? platformAuditService.createDeniedEvent({ principal,
            action: 'platform.authorization.denied', targetType: 'platform_passkey_operation', targetId: 'request',
            metadata: { reasonCode: 'passkey_rejected' }, correlationId: requestId })
            : platformAuditService.createUnmappedAuthenticationFailure({ reasonCode: 'passkey_rejected', correlationId: requestId });
          await platformAuditService.record(event);
        }
        throw new PlatformHttpError(managed ? 403 : 401, 'PLATFORM_PASSKEY_REJECTED',
          { securityCategory: managed ? 'authorization' : 'authentication' });
      }
    };
  },
});

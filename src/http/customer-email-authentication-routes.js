import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../domain/invitation-recipient.js';
import { clearCustomerEmailTransactionCookie,readCustomerEmailTransactionCookie,
  serializeCustomerEmailTransactionCookie } from '../identity/customer-email-cookie.js';
import { readSessionToken,serializeSessionCookie } from '../identity/session-cookie.js';
import { readJsonObjectBody,validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT = '/api/v1/auth/email';
const ROUTES = Object.freeze({
  [`${ROOT}/challenges`]: ['POST','customer_email_request'],
  [`${ROOT}/pending`]: ['GET','customer_email_pending'],
  [`${ROOT}/verify`]: ['POST','customer_email_verify'],
  [`${ROOT}/choices`]: ['GET','customer_email_choices'],
  [`${ROOT}/selection`]: ['POST','customer_email_selection'],
});
const outputInvalid = () => { throw new ApiError(500,'AUTHENTICATION_RESULT_INVALID'); };
function recipient(value) {
  try { normalizeInvitationRecipient(value); return true; } catch { return false; }
}
function publicPending(value,expected) {
  if (!value || !['code_required','membership_required'].includes(value.status)
    || (expected && value.status !== expected) || typeof value.csrfToken !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.csrfToken) || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt) outputInvalid();
  return { status: value.status,csrfToken: value.csrfToken,expiresAt: value.expiresAt };
}
function transactionCookie(value,clock) {
  const seconds = Math.ceil((Date.parse(value.expiresAt)-clock())/1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600) outputInvalid();
  try { return serializeCustomerEmailTransactionCookie(value,{ maxAgeSeconds: seconds }); }
  catch { outputInvalid(); }
}
function sessionCookie(value) {
  if (typeof value !== 'string' || value.length>256) outputInvalid();
  const token = readSessionToken({ cookie: value.split(';')[0] });
  const age = value.match(/; Max-Age=([1-9]\d{0,4})$/);
  if (!token || !age || Number(age[1])>86400
    || value !== serializeSessionCookie(token,{ secure: true,maxAgeSeconds: Number(age[1]) })) outputInvalid();
  return value;
}
function send(response,status,value,maxBytes) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body)>maxBytes) outputInvalid();
  response.statusCode=status; response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Content-Length',Buffer.byteLength(body)); response.end(body); return status;
}
async function emptyBody(request) {
  if (request.headers['transfer-encoding'] !== undefined
    || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
    throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
}
function csrf(request) {
  const token=request.headers['x-csrf-token'];
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(403,'CSRF_INVALID');
  return token;
}
function denied(value,response) {
  if (value?.status === 'limited') {
    response.setHeader('Retry-After','60'); throw new ApiError(429,'RATE_LIMITED');
  }
  if (value?.status === 'rejected') throw new ApiError(401,'AUTHENTICATION_REJECTED');
}

// Explicit injection keeps these anonymous preauthentication routes out of the
// closed Demo. createApp supplies the usual Host/target/rate/security/error guards.
export function createCustomerEmailAuthenticationRouteModule({ service,publicOrigin,clock = Date.now } = {}) {
  let origin;
  try { origin=new URL(publicOrigin); } catch { throw new TypeError('CUSTOMER_EMAIL_HTTP_CONFIGURATION_INVALID'); }
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || typeof clock !== 'function'
    || !service || ['request','pending','verify','choices','select'].some(name => typeof service[name] !== 'function')) {
    throw new TypeError('CUSTOMER_EMAIL_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({
    id: 'customer-email-authentication',routeKey: path => Object.hasOwn(ROUTES,path) ? ROUTES[path][1] : null,
    createHandler({ maxBodyBytes,maxResponseBytes } = {}) {
      if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('CUSTOMER_EMAIL_HTTP_CONFIGURATION_INVALID');
      }
      return async ({ request,response,path,parsedUrl,requestId }) => {
        if (!Object.hasOwn(ROUTES,path)) return null;
        const mutation=ROUTES[path][0] === 'POST';
        if (request.method !== ROUTES[path][0]) throw new ApiError(405,'METHOD_NOT_ALLOWED');
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        const site=request.headers['sec-fetch-site'];
        if ((site !== undefined && site !== 'same-origin')
          || (request.headers.origin !== undefined && request.headers.origin !== publicOrigin)
          || (mutation && request.headers.origin !== publicOrigin)) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        response.setHeader('Cache-Control','no-store'); response.setHeader('Referrer-Policy','no-referrer');
        if (!mutation) await emptyBody(request);
        if (path === `${ROOT}/challenges`) {
          const body=validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(maxBodyBytes,1024) }),
            { required: { recipient,locale: value => ['de','en'].includes(value) } });
          const result=await service.request({ recipient: body.recipient,locale: body.locale,
            sourceAddress: request.socket.remoteAddress });
          denied(result,response); const pending=publicPending(result,'code_required');
          response.setHeader('Set-Cookie',transactionCookie(result,clock));
          return send(response,202,{ ...pending,requestId },maxResponseBytes);
        }
        const cookie=readCustomerEmailTransactionCookie(request.headers);
        if (!cookie) throw new ApiError(401,'AUTHENTICATION_REJECTED');
        if (path === `${ROOT}/pending`) {
          const result=await service.pending(cookie); denied(result,response);
          return send(response,200,{ ...publicPending(result),requestId },maxResponseBytes);
        }
        if (path === `${ROOT}/choices`) {
          const result=await service.choices(cookie); denied(result,response);
          if (result?.status !== 'membership_required' || !Array.isArray(result.items) || result.items.length>100) outputInvalid();
          const seen=new Set();
          const items=result.items.map(item => {
            if (!isInternalUuid(item?.membershipId) || seen.has(item.membershipId.toLowerCase())
              || typeof item.displayName !== 'string' || item.displayName.length<1 || item.displayName.length>160
              || /[\u0000-\u001f\u007f]/.test(item.displayName)) outputInvalid();
            seen.add(item.membershipId.toLowerCase());
            return { membershipId: item.membershipId.toLowerCase(),displayName: item.displayName };
          });
          return send(response,200,{ status: 'membership_required',items,requestId },maxResponseBytes);
        }
        const csrfToken=csrf(request);
        const body=validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(maxBodyBytes,1024) }),
          { required: path === `${ROOT}/verify` ? { code: value => typeof value === 'string' && /^\d{8}$/.test(value) }
            : { membershipId: isInternalUuid } });
        if (path === `${ROOT}/verify`) {
          const result=await service.verify({ ...cookie,csrfToken,code: body.code,sourceAddress: request.socket.remoteAddress });
          denied(result,response); const pending=publicPending(result,'membership_required');
          response.setHeader('Set-Cookie',transactionCookie(result,clock));
          return send(response,200,{ ...pending,requestId },maxResponseBytes);
        }
        const result=await service.select({ ...cookie,csrfToken,correlationId: requestId },{ membershipId: body.membershipId });
        denied(result,response); if (result?.status !== 'authenticated') outputInvalid();
        response.setHeader('Set-Cookie',[sessionCookie(result.setCookie),clearCustomerEmailTransactionCookie()]);
        response.statusCode=204; response.end(); return 204;
      };
    },
  });
}

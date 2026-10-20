import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCustomerInvitationIntent } from '../authorization/customer-invitation-policy.js';
import { readJsonObjectBody,validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT='/api/v1/tenant/invitations';
const ACTION=/^\/api\/v1\/tenant\/invitations\/([^/]{1,64})\/(reissue|revoke)$/;
const revision=value => Number.isSafeInteger(value) && value>=1 && value<Number.MAX_SAFE_INTEGER;
const invalidResult=() => { throw new ApiError(500,'CUSTOMER_INVITATION_RESULT_INVALID'); };
function invitation(value) {
  if (!value || !isInternalUuid(value.id) || !revision(value.revision)
    || !['pending','accepted','revoked','expired'].includes(value.state)
    || !['queued','processing','accepted','failed','cancelled'].includes(value.delivery)
    || (value.state==='revoked' && value.delivery==='queued')
    || typeof value.expiresAt!=='string' || !Number.isFinite(Date.parse(value.expiresAt))
    || new Date(value.expiresAt).toISOString()!==value.expiresAt) invalidResult();
  let intent;
  try { intent=normalizeCustomerInvitationIntent({ recipient: value.recipient,roles: value.roles,locale: value.locale }); }
  catch { invalidResult(); }
  if (intent.recipient!==value.recipient || JSON.stringify(intent.roles)!==JSON.stringify(value.roles)) invalidResult();
  return { id: value.id.toLowerCase(),revision: value.revision,...intent,
    state: value.state,expiresAt: value.expiresAt,delivery: value.delivery };
}
function invitations(value,maximum) {
  if (!Array.isArray(value) || value.length>maximum) invalidResult();
  const rows=value.map(invitation);
  if (new Set(rows.map(row => row.id)).size!==rows.length) invalidResult();return rows;
}
function send(response,status,value,maxBytes) {
  const body=JSON.stringify(value);if (Buffer.byteLength(body)>maxBytes) invalidResult();
  response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Content-Length',Buffer.byteLength(body));response.end(body);return status;
}
function page(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!['limit','afterId'].includes(key) || parsedUrl.searchParams.getAll(key).length!==1) throw new ApiError(400,'VALIDATION_FAILED');
  }
  const limit=parsedUrl.searchParams.get('limit'),after=parsedUrl.searchParams.get('afterId');
  if ((limit!==null && !/^(?:[1-9][0-9]?|100)$/.test(limit)) || (after!==null && !isInternalUuid(after))) {
    throw new ApiError(400,'VALIDATION_FAILED');
  }
  return { limit: limit===null ? 50 : Number(limit),afterInvitationId: after===null ? null : after.toLowerCase() };
}
async function emptyBody(request) {
  if (request.headers['transfer-encoding']!==undefined
    || (request.headers['content-length']!==undefined && request.headers['content-length']!=='0')) {
    throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
}

// Only explicit real Customer composition may install this module. Customer
// Tenant Admin authority remains separate from Platform operator onboarding.
export function createCustomerInvitationRouteModule({ service,publicOrigin } = {}) {
  let origin;
  try { origin=new URL(publicOrigin); } catch { throw new TypeError('CUSTOMER_INVITATION_HTTP_CONFIGURATION_INVALID'); }
  if (origin.protocol!=='https:' || origin.origin!==publicOrigin
    || !service || ['list','issueBatch','reissue','revoke'].some(name => typeof service[name]!=='function')) {
    throw new TypeError('CUSTOMER_INVITATION_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'customer-invitations',
    routeKey: path => path===ROOT ? 'customer_invitations' : ACTION.test(path) ? 'customer_invitation_mutation' : null,
    createHandler({ principalGuard,tenantGuard,maxBodyBytes,maxResponseBytes } = {}) {
      if (typeof principalGuard?.require!=='function' || typeof tenantGuard?.requireKnown!=='function'
        || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('CUSTOMER_INVITATION_HTTP_CONFIGURATION_INVALID');
      }
      return async ({ request,response,path,parsedUrl,requestId }) => {
        const match=path.match(ACTION);if (path!==ROOT && !match) return null;
        const read=path===ROOT && request.method==='GET';
        if ((!read && request.method!=='POST') || (match && !isInternalUuid(match[1]))) throw new ApiError(
          match && !isInternalUuid(match[1]) ? 404 : 405,match && !isInternalUuid(match[1]) ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED');
        if (request.headers['sec-fetch-site']!==undefined && request.headers['sec-fetch-site']!=='same-origin') {
          throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        }
        if (!read && request.headers.origin!==publicOrigin) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        const principal=await principalGuard.require(request,{ csrf: !read });
        const tenantContext=await tenantGuard.requireKnown(principal),context={ principal,tenantContext,correlationId: requestId };
        if (read) {
          await emptyBody(request);const result=await service.list(context,page(parsedUrl));
          return send(response,200,{ invitations: invitations(result,100),requestId },maxResponseBytes);
        }
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        const body=await readJsonObjectBody(request,{ maxBytes: Math.min(maxBodyBytes,16384) });
        if (!match) {
          validateExactObject(body,{ required: { commandId: isInternalUuid,
            invitations: value => Array.isArray(value) && value.length>=1 && value.length<=20 } });
          const result=await service.issueBatch(context,body);
          return send(response,201,{ invitations: invitations(result,20),requestId },maxResponseBytes);
        }
        validateExactObject(body,{ required: { expectedRevision: revision } });
        const result=await service[match[2]](context,{ invitationId: match[1].toLowerCase(),expectedRevision: body.expectedRevision });
        return send(response,200,{ invitation: invitation(result),requestId },maxResponseBytes);
      };
    },
  });
}

import { ApiError } from '../../api-error.js';
import { defineRouteModule } from '../../http/route-module.js';
import { readJsonObjectBody, validateExactObject } from '../../security.js';

export const DEMO_CUSTOMER_SESSION_PATH = '/api/v1/demo/session';
export const DEMO_CUSTOMER_CONTEXT_PATH = '/api/v1/demo/session/context';
export const DEMO_CUSTOMER_TENANTS_PATH = '/api/v1/demo/tenants';
export const DEMO_CUSTOMER_MEDIA_PATH = '/api/v1/demo/media';
const DEMO_MEDIA_ASSET_PATH = /^\/api\/v1\/demo\/media\/([0-9a-f-]{36})$/i;

const CONTEXT_SCHEMA = Object.freeze({
  required: Object.freeze({
    tenantId: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    persona: (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{1,31}$/.test(value),
  }),
  optional: Object.freeze({}),
});

function routeKey(path) {
  if (path === DEMO_CUSTOMER_SESSION_PATH) return 'demo_customer_session';
  if (path === DEMO_CUSTOMER_CONTEXT_PATH) return 'demo_customer_context';
  if (path === DEMO_CUSTOMER_TENANTS_PATH) return 'demo_customer_tenants';
  if (path === DEMO_CUSTOMER_MEDIA_PATH || DEMO_MEDIA_ASSET_PATH.test(path)) return 'demo_customer_media';
  return null;
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
}

async function assertNoBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^0$/.test(String(length)) || Array.isArray(length))) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function sessionProjection(result, tenantContext, requestId) {
  const { principal, selection, csrfToken } = result;
  return Object.freeze({
    user: Object.freeze({ id: principal.userId }),
    tenant: Object.freeze({ id: tenantContext.tenantId, status: tenantContext.status }),
    roles: principal.roles,
    permissions: principal.permissions,
    session: Object.freeze({ expiresAt: principal.session.expiresAt }),
    csrfToken,
    demo: Object.freeze({ persona: selection.persona }),
    requestId,
  });
}

function normalizeContextError(error) {
  if (
    error?.message === 'DEMO_CUSTOMER_SESSION_INVALID'
    || error?.message === 'DEMO_CUSTOMER_SESSION_AUTHORITY_INVALID'
  ) {
    return new ApiError(401, 'UNAUTHENTICATED');
  }
  if (error?.message === 'DEMO_CUSTOMER_CONTEXT_INVALID') {
    return new ApiError(400, 'VALIDATION_FAILED');
  }
  if (error?.message === 'DEMO_CUSTOMER_CONTEXT_NOT_AVAILABLE') {
    return new ApiError(404, 'DEMO_CONTEXT_NOT_AVAILABLE');
  }
  return error;
}

export function createDemoCustomerControlRoutes({ personaService, mediaRepository } = {}) {
  if (
    !personaService
    || typeof personaService.establish !== 'function'
    || typeof personaService.switch !== 'function'
    || typeof personaService.tenants !== 'function'
    || typeof personaService.clearCookie !== 'function'
  ) throw new TypeError('DEMO_CUSTOMER_PERSONA_SERVICE_REQUIRED');

  return defineRouteModule({
    id: 'demo-customer-control',
    routeKey,
    createHandler({ principalGuard, tenantGuard, maxBodyBytes, maxResponseBytes }) {
      return async function handle({ request, response, parsedUrl, path, requestId }) {
        const key = routeKey(path);
        if (!key) return null;
        assertNoQuery(parsedUrl);

        if (path === DEMO_CUSTOMER_SESSION_PATH) {
          if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          await assertNoBody(request);
          let result;
          try {
            result = await personaService.establish(request, { correlationId: requestId });
          } catch (error) {
            if (
              error?.message === 'DEMO_CUSTOMER_SESSION_INVALID'
              || error?.message === 'DEMO_CUSTOMER_SESSION_AUTHORITY_INVALID'
            ) response.setHeader('Set-Cookie', personaService.clearCookie());
            throw normalizeContextError(error);
          }
          const tenantContext = await tenantGuard.requireKnown(result.principal);
          if (result.setCookie) response.setHeader('Set-Cookie', result.setCookie);
          sendJson(response, 200, sessionProjection(result, tenantContext, requestId), maxResponseBytes);
          return 200;
        }

        if (path === DEMO_CUSTOMER_MEDIA_PATH || DEMO_MEDIA_ASSET_PATH.test(path)) {
          if (!mediaRepository || typeof mediaRepository.find !== 'function'
            || typeof mediaRepository.list !== 'function') {
            throw new ApiError(503, 'DEMO_MEDIA_UNAVAILABLE');
          }
          if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          await assertNoBody(request);
          const principal = await principalGuard.require(request);
          const tenant = await tenantGuard.requireKnown(principal);
          const assetId = path.match(DEMO_MEDIA_ASSET_PATH)?.[1];
          if (assetId) {
            const media = await mediaRepository.find({ tenantId: tenant.tenantId, assetId });
            if (!media) throw new ApiError(404, 'NOT_FOUND');
            if (!Buffer.isBuffer(media.bytes) || media.bytes.length !== Number(media.byte_length)
              || !['image/png', 'image/webp'].includes(media.content_type)) {
              throw new ApiError(500, 'DEMO_MEDIA_CORRUPT');
            }
            response.statusCode = 200;
            response.setHeader('Content-Type', media.content_type);
            response.setHeader('Content-Length', media.bytes.length);
            response.setHeader('Cache-Control', 'private, no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.end(media.bytes);
            return 200;
          }
          const assets = await mediaRepository.list({ tenantId: tenant.tenantId });
          response.setHeader('Cache-Control', 'private, no-store');
          sendJson(response, 200, {
            assets: assets.map((entry) => ({ ...entry,
              url: `${DEMO_CUSTOMER_MEDIA_PATH}/${entry.id}`,
            })),
            requestId,
          }, maxResponseBytes);
          return 200;
        }

        if (path === DEMO_CUSTOMER_TENANTS_PATH) {
          if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          await assertNoBody(request);
          await principalGuard.require(request);
          sendJson(response, 200, {
            tenants: await personaService.tenants(),
            requestId,
          }, maxResponseBytes);
          return 200;
        }

        if (request.method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const principal = await principalGuard.require(request, { csrf: true });
        const body = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
          CONTEXT_SCHEMA,
        );
        let result;
        try {
          result = await personaService.switch(principal, {
            ...body,
            correlationId: requestId,
          });
        } catch (error) {
          throw normalizeContextError(error);
        }
        response.setHeader('Set-Cookie', result.setCookie);
        const tenantContext = await tenantGuard.requireKnown(result.principal);
        sendJson(response, 200, sessionProjection(result, tenantContext, requestId), maxResponseBytes);
        return 200;
      };
    },
  });
}

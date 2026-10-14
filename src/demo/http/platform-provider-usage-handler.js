import { applyPlatformSecurityHeaders, createPlatformRequestId } from '../../platform/http/security.js';

export const DEMO_PROVIDER_USAGE_PATH = '/api/v1/platform/demo/provider-usage';

export function handleDemoProviderUsage({ request, response, accessGate, providerUsage }) {
  if (request.url?.split('?', 1)[0] !== DEMO_PROVIDER_USAGE_PATH) return false;
  const requestId = createPlatformRequestId();
  let status = 200;
  let payload;
  if (!providerUsage || accessGate?.hasPrivateReadAccess(request) !== true) {
    status = 404;
    payload = { error: { code: 'PLATFORM_NOT_FOUND', requestId } };
  } else if (request.method !== 'GET') {
    status = 405;
    payload = { error: { code: 'PLATFORM_METHOD_NOT_ALLOWED', requestId } };
    response.setHeader('Allow', 'GET');
  } else if (request.url !== DEMO_PROVIDER_USAGE_PATH
    || request.headers['transfer-encoding'] !== undefined
    || ![undefined, '0'].includes(request.headers['content-length'])) {
    status = 400;
    payload = { error: { code: 'PLATFORM_REQUEST_INVALID', requestId } };
  } else {
    try { payload = providerUsage.read(); } catch {
      status = 503;
      payload = { error: { code: 'PLATFORM_PROVIDER_USAGE_UNAVAILABLE', requestId } };
    }
  }
  const body = JSON.stringify(payload);
  applyPlatformSecurityHeaders(response, { mode: 'demo' });
  response.statusCode = status;
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Connection', 'close');
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}

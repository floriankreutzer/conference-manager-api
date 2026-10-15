import {
  applyPlatformSecurityHeaders,
  createPlatformRequestId,
} from '../../platform/http/security.js';

export function handleDemoPrivateProjection({
  request,
  response,
  accessGate,
  projection,
  path,
  unavailableCode,
}) {
  if (request.url?.split('?', 1)[0] !== path) return false;
  const requestId = createPlatformRequestId();
  let status = 200;
  let payload;
  function finish(result) {
    if (response.destroyed || response.writableEnded) return true;
    try {
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || Buffer.byteLength(JSON.stringify(result)) > 64_000) throw new TypeError('PROJECTION_INVALID');
    } catch {
      status = 503;
      result = { error: { code: unavailableCode, requestId } };
    }
    const body = JSON.stringify(result);
    applyPlatformSecurityHeaders(response, { mode: 'demo' });
    response.statusCode = status;
    response.setHeader('X-Request-ID', requestId);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.setHeader('Connection', 'close');
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  }
  if (!projection || accessGate?.hasPrivateReadAccess(request) !== true) {
    status = 404;
    payload = { error: { code: 'PLATFORM_NOT_FOUND', requestId } };
  } else if (request.method !== 'GET') {
    status = 405;
    payload = { error: { code: 'PLATFORM_METHOD_NOT_ALLOWED', requestId } };
    response.setHeader('Allow', 'GET');
  } else if (
    request.url !== path ||
    request.headers['transfer-encoding'] !== undefined ||
    ![undefined, '0'].includes(request.headers['content-length'])
  ) {
    status = 400;
    payload = { error: { code: 'PLATFORM_REQUEST_INVALID', requestId } };
  } else {
    try {
      payload = projection.read();
      if (payload instanceof Promise) return payload.then(finish, () => {
        status = 503;
        return finish({ error: { code: unavailableCode, requestId } });
      });
    } catch {
      status = 503;
      payload = { error: { code: unavailableCode, requestId } };
    }
  }
  return finish(payload);
}

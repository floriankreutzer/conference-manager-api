import { timingSafeEqual } from 'node:crypto';

export const DEMO_ACCEPTANCE_HEADER = 'x-cm-demo-acceptance';

function consumeToken(request) {
  // Materialize both Node caches before shortening rawHeaders: Node retains the
  // original internal header count when it lazily builds these public objects.
  const headers = request.headers;
  const distinctHeaders = request.headersDistinct;
  const values = [];
  const retained = [];
  for (let index = 0; index < (request.rawHeaders?.length || 0); index += 2) {
    const name = request.rawHeaders[index];
    if (name.toLowerCase() === DEMO_ACCEPTANCE_HEADER) values.push(request.rawHeaders[index + 1]);
    else retained.push(name, request.rawHeaders[index + 1]);
  }
  request.rawHeaders = retained;
  delete headers[DEMO_ACCEPTANCE_HEADER];
  if (distinctHeaders) delete distinctHeaders[DEMO_ACCEPTANCE_HEADER];
  return values.length === 1 ? values[0] : null;
}

function send(response, config, boundary, statusCode, body) {
  const requestId = boundary.createRequestId();
  const payload = JSON.stringify({ ...body, requestId });
  boundary.applySecurityHeaders(response, { mode: config.environment });
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(payload));
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('Connection', 'close');
  if (statusCode === 503) response.setHeader('Retry-After', '60');
  response.end(payload);
}

export function createDemoTrafficGate({ settings, config, surface, boundary, clock = () => Date.now() } = {}) {
  if (!['customer', 'platform'].includes(surface) || !config?.origins?.[surface]
    || !['open', 'closed', 'acceptance'].includes(settings?.mode) || typeof clock !== 'function'
    || (settings.mode === 'acceptance' && (!/^[a-f0-9]{64}$/.test(settings.token || '')
      || !Number.isFinite(settings.expiresAt)))
    || ['createRequestId', 'applySecurityHeaders', 'assertRequestTarget', 'assertRequestHost', 'assertRequestOrigin']
      .some((key) => typeof boundary?.[key] !== 'function')) {
    throw new TypeError('DEMO_TRAFFIC_GATE_INVALID');
  }
  const prefix = surface === 'customer' ? '/api/v1/health/' : '/api/v1/platform/health/';
  const publicOrigin = config.origins[surface];
  const expected = settings.mode === 'acceptance' ? Buffer.from(settings.token, 'hex') : null;
  let expired = false;
  let active = false;
  function state() {
    if (expired) return active ? 'draining' : 'expired';
    if (settings.mode !== 'acceptance') return settings.mode;
    const now = clock();
    if (!Number.isFinite(now) || now >= settings.expiresAt) expired = true;
    return expired ? (active ? 'draining' : 'expired') : 'acceptance';
  }
  function handle(request, response) {
    const token = consumeToken(request);
    const current = state();
    const deploymentProbe = request.url === `${prefix}deploy`;
    if (current === 'open' && !deploymentProbe) return false;
    try {
      boundary.assertRequestTarget(request.url);
      boundary.assertRequestHost(request.headers, publicOrigin);
      boundary.assertRequestOrigin(request.headers, publicOrigin);
    } catch {
      send(response, config, boundary, 400, { error: { code: 'DEMO_TRAFFIC_REQUEST_INVALID' } });
      return true;
    }
    if (deploymentProbe && request.method === 'GET'
      && request.headers['transfer-encoding'] === undefined
      && [undefined, '0'].includes(request.headers['content-length'])) {
      if (current === 'open' || current === 'acceptance') {
        // Reuse the ordinary dependency/readiness authority; do not weaken the
        // provider's health check when the application is active.
        request.url = `${prefix}ready`;
        return false;
      }
      send(response, config, boundary, current === 'draining' ? 503 : 200, {
        status: current === 'draining' ? 'deployment_not_ready' : 'deployment_ready', trafficMode: current,
      });
      return true;
    }
    if ((current === 'closed' || current === 'expired')
      && request.method === 'GET' && request.url === `${prefix}live`) {
      send(response, config, boundary, 200, { status: 'ok' });
      return true;
    }
    if (current === 'acceptance' && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
      && timingSafeEqual(Buffer.from(token, 'hex'), expected)) return false;
    send(response, config, boundary, 503, { error: { code: 'DEMO_TRAFFIC_CLOSED' } });
    return true;
  }
  return Object.freeze({ handle, state, close() { expired = true; },
    markActive() { active = true; }, markQuiescent() { active = false; } });
}

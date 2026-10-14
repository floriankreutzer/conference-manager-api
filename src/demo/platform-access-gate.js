import { createHash, timingSafeEqual } from 'node:crypto';
import { createPlatformLogger } from '../platform/http/observability.js';
import {
  applyPlatformSecurityHeaders,
  assertPlatformRequestHost,
  assertPlatformRequestOrigin,
  assertPlatformRequestTarget,
  createPlatformRateLimiter,
  createPlatformRequestId,
} from '../platform/http/security.js';

const HEALTH_PATHS = new Set([
  '/api/v1/platform/health/live',
  '/api/v1/platform/health/ready',
  '/api/v1/platform/health/deploy',
]);
const HASH_NAMESPACE = 'conference-manager:demo-platform-access:v1:';

function consumeAuthorization(request) {
  const headers = request.headers;
  const distinct = request.headersDistinct;
  const values = [];
  const retained = [];
  for (let index = 0; index < (request.rawHeaders?.length || 0); index += 2) {
    const name = request.rawHeaders[index];
    if (name.toLowerCase() === 'authorization') values.push(request.rawHeaders[index + 1]);
    else retained.push(name, request.rawHeaders[index + 1]);
  }
  request.rawHeaders = retained;
  delete headers.authorization;
  if (distinct) delete distinct.authorization;
  return values.length === 1 ? values[0] : null;
}

function passwordFromAuthorization(value) {
  if (typeof value !== 'string' || value.length !== 70 || !/^Basic [A-Za-z0-9+/]{63}=$/i.test(value)) return null;
  const encoded = value.slice(6);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) return null;
  return decoded.toString('utf8').match(/^ops:([A-Za-z0-9_-]{43})$/)?.[1] ?? null;
}

function digest(password) {
  return createHash('sha256').update(HASH_NAMESPACE).update(password).digest();
}

function reject(response, statusCode, logger) {
  const requestId = createPlatformRequestId();
  const code = statusCode === 401 ? 'PLATFORM_DEMO_ACCESS_REQUIRED'
    : statusCode === 429 ? 'PLATFORM_DEMO_ACCESS_RATE_LIMITED' : 'PLATFORM_DEMO_ACCESS_REQUEST_INVALID';
  const body = JSON.stringify({ error: { code, requestId } });
  applyPlatformSecurityHeaders(response, { mode: 'demo' });
  response.statusCode = statusCode;
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Connection', 'close');
  if (statusCode === 401) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Conference Manager Operations", charset="UTF-8"');
  }
  if (statusCode === 429) response.setHeader('Retry-After', '60');
  response.end(body);
  try {
    logger.securityOutcome({ requestId, category: 'authentication' });
  } catch {
    // Operational observation cannot turn an access denial into application access.
  }
}

export function createDemoPlatformAccessGate({
  settings, publicOrigin, clock = () => Date.now(), logger = createPlatformLogger(),
} = {}) {
  if (!['public', 'password'].includes(settings?.mode)
    || (settings.mode === 'password' && (typeof settings.passwordHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(settings.passwordHash)))
    || (settings.mode === 'public' && settings.passwordHash !== null)
    || typeof clock !== 'function' || typeof logger?.securityOutcome !== 'function') {
    throw new TypeError('DEMO_PLATFORM_ACCESS_GATE_INVALID');
  }
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) {
    throw new TypeError('DEMO_PLATFORM_ACCESS_GATE_INVALID');
  }
  const expected = settings.mode === 'password' ? Buffer.from(settings.passwordHash, 'hex') : null;
  const failures = createPlatformRateLimiter({ max: 30, windowMs: 60_000, maxKeys: 1_000, clock });
  return Object.freeze({
    handle(request, response) {
      if (settings.mode === 'public') return false;
      const authorization = consumeAuthorization(request);
      try {
        assertPlatformRequestTarget(request.url);
        assertPlatformRequestHost(request.headers, publicOrigin);
        assertPlatformRequestOrigin(request.headers, publicOrigin);
      } catch {
        reject(response, 400, logger);
        return true;
      }
      if (request.method === 'GET' && HEALTH_PATHS.has(request.url)
        && request.headers['transfer-encoding'] === undefined
        && [undefined, '0'].includes(request.headers['content-length'])) return false;
      const password = passwordFromAuthorization(authorization);
      if (password !== null && timingSafeEqual(digest(password), expected)) return false;
      try {
        // Forwarded headers are not trusted; successful credentials do not consume this failure budget.
        failures.consume(request.socket?.remoteAddress || 'unknown');
      } catch {
        reject(response, 429, logger);
        return true;
      }
      reject(response, 401, logger);
      return true;
    },
  });
}

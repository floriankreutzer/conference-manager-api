import { randomUUID } from 'node:crypto';
import { ApiError } from './api-error.js';
import { isInternalUuid } from './domain/identifiers.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROLE_PATTERN = /^[a-z][a-z0-9:_-]{1,63}$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const REQUEST_TARGET_LIMIT = 8_192;

export function createRequestId() {
  return randomUUID();
}

export function assertAllowedMethod(method) {
  if (!ALLOWED_METHODS.has(method || '')) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
}

export function assertSafeRequestTarget(rawUrl) {
  if (
    typeof rawUrl !== 'string'
    || !rawUrl
    || rawUrl.length > REQUEST_TARGET_LIMIT
    || !rawUrl.startsWith('/')
    || rawUrl.startsWith('//')
  ) {
    throw new ApiError(400, 'REQUEST_TARGET_INVALID');
  }
  const path = rawUrl.split('?', 1)[0];
  if (/\\|\0|%2f|%5c/i.test(path)) throw new ApiError(400, 'REQUEST_TARGET_INVALID');

  let decoded = path;
  for (let index = 0; index < 2; index += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new ApiError(400, 'REQUEST_TARGET_INVALID');
    }
    if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new ApiError(400, 'REQUEST_TARGET_INVALID');
    }
  }
}

export function assertRequestHost(headers, publicOrigin) {
  const expected = new URL(publicOrigin).host;
  const host = headers.host;
  if (typeof host !== 'string' || host.toLowerCase() !== expected.toLowerCase()) {
    throw new ApiError(400, 'HOST_NOT_ALLOWED');
  }
}

export function assertSameOrigin(headers, publicOrigin) {
  const origin = headers.origin;
  if (origin === undefined) return;
  if (Array.isArray(origin) || typeof origin !== 'string') throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');
  }
  if (parsed.origin !== publicOrigin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');
}

export function applySecurityHeaders(response, { mode }) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  if (mode === 'pilot' || mode === 'production') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function createRateLimiter({ max, windowMs, maxKeys = 10_000, clock = () => Date.now() }) {
  const buckets = new Map();

  function prune(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return Object.freeze({
    consume(key) {
      const now = clock();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        if (!bucket && buckets.size >= maxKeys) {
          prune(now);
          if (buckets.size >= maxKeys) throw new ApiError(429, 'RATE_LIMITED');
        }
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > max) throw new ApiError(429, 'RATE_LIMITED');
      return Object.freeze({ remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt });
    },
  });
}

export async function readJsonObjectBody(request, { maxBytes }) {
  const contentEncoding = request.headers['content-encoding'];
  if (contentEncoding && contentEncoding !== 'identity') throw new ApiError(415, 'CONTENT_ENCODING_NOT_ALLOWED');

  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const length = request.headers['content-length'];
  if (length !== undefined) {
    if (Array.isArray(length) || !/^\d+$/.test(length)) throw new ApiError(400, 'CONTENT_LENGTH_INVALID');
    if (Number(length) > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }

  if (bytes === 0) throw new ApiError(400, 'BODY_REQUIRED');

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'JSON_OBJECT_REQUIRED');
  return parsed;
}

export function validateExactObject(value, { required = {}, optional = {} }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'VALIDATION_FAILED');
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ApiError(400, 'VALIDATION_FAILED');

  for (const [key, validate] of Object.entries(required)) {
    if (!(key in value) || !validate(value[key])) throw new ApiError(400, 'VALIDATION_FAILED');
  }
  for (const [key, validate] of Object.entries(optional)) {
    if (key in value && !validate(value[key])) throw new ApiError(400, 'VALIDATION_FAILED');
  }
  return value;
}

export function normalizePrincipal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(401, 'UNAUTHENTICATED');
  const { userId, tenantId, roles } = value;
  if (!isInternalUuid(userId) || !isInternalUuid(tenantId)) {
    throw new ApiError(401, 'UNAUTHENTICATED');
  }
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 16 || roles.some((role) => !ROLE_PATTERN.test(role))) {
    throw new ApiError(401, 'UNAUTHENTICATED');
  }
  return Object.freeze({ userId, tenantId, roles: Object.freeze([...new Set(roles)]) });
}

export function createPrincipalGuard({ resolvePrincipal = async () => null, verifyCsrf = async () => false } = {}) {
  return Object.freeze({
    async require(request, { csrf = false } = {}) {
      const principal = normalizePrincipal(await resolvePrincipal(request));
      if (csrf && UNSAFE_METHODS.has(request.method)) {
        const verified = await verifyCsrf(request, principal);
        if (verified !== true) throw new ApiError(403, 'CSRF_INVALID');
      }
      return principal;
    },
  });
}

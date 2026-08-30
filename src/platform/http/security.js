import { randomUUID } from 'node:crypto';
import { PlatformHttpError } from './errors.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'DELETE']);
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const REQUEST_TARGET_LIMIT = 8_192;

export function createPlatformRequestId() {
  return randomUUID();
}

export function assertPlatformMethod(method) {
  if (!ALLOWED_METHODS.has(method || '')) {
    throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
  }
}

export function isPlatformUnsafeMethod(method) {
  return UNSAFE_METHODS.has(method || '');
}

export function assertPlatformRequestTarget(rawUrl) {
  if (
    typeof rawUrl !== 'string'
    || rawUrl.length < 1
    || rawUrl.length > REQUEST_TARGET_LIMIT
    || !rawUrl.startsWith('/')
    || rawUrl.startsWith('//')
  ) {
    throw new PlatformHttpError(400, 'PLATFORM_REQUEST_TARGET_INVALID');
  }
  const path = rawUrl.split('?', 1)[0];
  if (/\\|\0|%2f|%5c/i.test(path)) {
    throw new PlatformHttpError(400, 'PLATFORM_REQUEST_TARGET_INVALID');
  }

  let decoded = path;
  for (let index = 0; index < 2; index += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new PlatformHttpError(400, 'PLATFORM_REQUEST_TARGET_INVALID');
    }
    if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new PlatformHttpError(400, 'PLATFORM_REQUEST_TARGET_INVALID');
    }
  }
}

export function assertPlatformRequestHost(headers, publicOrigin) {
  const expected = new URL(publicOrigin).host;
  if (typeof headers?.host !== 'string' || headers.host !== expected) {
    throw new PlatformHttpError(400, 'PLATFORM_HOST_NOT_ALLOWED');
  }
}

export function assertPlatformRequestOrigin(headers, publicOrigin, { required = false } = {}) {
  const origin = headers?.origin;
  if (origin === undefined) {
    if (required) {
      throw new PlatformHttpError(403, 'PLATFORM_ORIGIN_NOT_ALLOWED', {
        securityCategory: 'authorization',
      });
    }
    return;
  }
  if (Array.isArray(origin) || typeof origin !== 'string' || origin !== publicOrigin) {
    throw new PlatformHttpError(403, 'PLATFORM_ORIGIN_NOT_ALLOWED', {
      securityCategory: 'authorization',
    });
  }
  try {
    if (new URL(origin).origin !== publicOrigin) throw new Error('origin mismatch');
  } catch {
    throw new PlatformHttpError(403, 'PLATFORM_ORIGIN_NOT_ALLOWED', {
      securityCategory: 'authorization',
    });
  }
}

export function applyPlatformSecurityHeaders(response, { mode }) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  if (mode === 'demo' || mode === 'pilot' || mode === 'production') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function createPlatformRateLimiter({
  max,
  windowMs,
  maxKeys = 10_000,
  clock = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10_000) {
    throw new TypeError('PLATFORM_RATE_LIMIT_MAX_INVALID');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) {
    throw new TypeError('PLATFORM_RATE_LIMIT_WINDOW_INVALID');
  }
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100_000) {
    throw new TypeError('PLATFORM_RATE_LIMIT_KEY_BOUND_INVALID');
  }
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_RATE_LIMIT_CLOCK_REQUIRED');
  const buckets = new Map();

  function prune(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return Object.freeze({
    consume(key) {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('PLATFORM_RATE_LIMIT_CLOCK_INVALID');
      const boundedKey = typeof key === 'string' && key.length >= 1 && key.length <= 128 ? key : 'unknown';
      let bucket = buckets.get(boundedKey);
      if (!bucket || bucket.resetAt <= now) {
        if (!bucket && buckets.size >= maxKeys) {
          prune(now);
          if (buckets.size >= maxKeys) throw new PlatformHttpError(429, 'PLATFORM_RATE_LIMITED');
        }
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(boundedKey, bucket);
      }
      bucket.count += 1;
      if (bucket.count > max) throw new PlatformHttpError(429, 'PLATFORM_RATE_LIMITED');
      return Object.freeze({
        remaining: Math.max(0, max - bucket.count),
        resetAt: bucket.resetAt,
      });
    },
  });
}

export async function assertNoPlatformRequestBody(request) {
  const length = request.headers['content-length'];
  if (
    request.headers['transfer-encoding'] !== undefined
    || (length !== undefined && (Array.isArray(length) || length !== '0'))
    || request.headers['content-type'] !== undefined
    || request.headers['content-encoding'] !== undefined
  ) {
    throw new PlatformHttpError(400, 'PLATFORM_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new PlatformHttpError(400, 'PLATFORM_BODY_NOT_ALLOWED');
  }
}

export async function readPlatformJsonObject(request, { maxBytes }) {
  const contentEncoding = request.headers['content-encoding'];
  if (contentEncoding !== undefined && contentEncoding !== 'identity') {
    throw new PlatformHttpError(415, 'PLATFORM_CONTENT_ENCODING_NOT_ALLOWED');
  }
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw new PlatformHttpError(415, 'PLATFORM_UNSUPPORTED_MEDIA_TYPE');
  }
  const length = request.headers['content-length'];
  if (length !== undefined) {
    if (Array.isArray(length) || !/^\d+$/.test(length)) {
      throw new PlatformHttpError(400, 'PLATFORM_CONTENT_LENGTH_INVALID');
    }
    if (Number(length) > maxBytes) throw new PlatformHttpError(413, 'PLATFORM_BODY_TOO_LARGE');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new PlatformHttpError(413, 'PLATFORM_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new PlatformHttpError(400, 'PLATFORM_BODY_REQUIRED');

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PlatformHttpError(400, 'PLATFORM_JSON_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformHttpError(400, 'PLATFORM_JSON_OBJECT_REQUIRED');
  }
  return value;
}

export function requirePlatformExactObject(value, { required = {}, optional = {} } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  for (const [key, validate] of Object.entries(required)) {
    if (!Object.hasOwn(value, key) || validate(value[key]) !== true) {
      throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    }
  }
  for (const [key, validate] of Object.entries(optional)) {
    if (Object.hasOwn(value, key) && validate(value[key]) !== true) {
      throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    }
  }
  return value;
}

export function assertPlatformNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
}

import { performance } from 'node:perf_hooks';
import { isInternalUuid } from '../../src/domain/identifiers.js';

function valid(value) { if (!value) throw new Error('LOAD_BOOKING_TRANSPORT_INVALID'); }

function validPath(kind, path) {
  if (typeof path !== 'string') return false;
  if (kind === 'session_read') return path === '/api/v1/session';
  if (kind === 'room_page_read') {
    return /^\/api\/v1\/application\/catalog\?section=rooms&limit=5&(?:context|cursor)=[A-Za-z0-9_-]{1,2048}$/.test(path);
  }
  if (kind === 'availability_lookup') return path === '/api/v1/application/room-availability';
  if (kind === 'request_create') return path === '/api/v1/application/requests';
  const match = kind === 'media_read' ? path.match(/^\/api\/v1\/tenant\/rooms\/room\/media\/([^/]+)$/)
    : kind === 'request_read' ? path.match(/^\/api\/v1\/requests\/([^/]+)$/)
      : kind === 'request_transition' ? path.match(/^\/api\/v1\/requests\/([^/]+)\/transitions$/) : null;
  return Boolean(match && isInternalUuid(match[1]));
}

// Local integration adapter only; remote targets require a separate scope-verified
// HTTPS adapter. Keep the same fetch pool across all choreography steps.
export function createLoopbackBookingExchange(origin) {
  let url;
  try {
    valid(typeof origin === 'string' && origin.length <= 128); url = new URL(origin);
    valid(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
  } catch { throw new Error('LOAD_BOOKING_TRANSPORT_INVALID'); }
  return async function exchange({ kind, actor, path, method, cookie, csrfToken, body, expectedVersion, binary, signal }) {
    try {
      valid(validPath(kind, path) && ['employee', 'manager'].includes(actor));
      valid(typeof cookie === 'string' && /^cm_session=[A-Za-z0-9_-]{43}$/.test(cookie));
      valid(signal instanceof AbortSignal && typeof binary === 'boolean' && binary === (kind === 'media_read'));
      const write = ['availability_lookup', 'request_create', 'request_transition'].includes(kind);
      valid(method === (write ? 'POST' : 'GET'));
      valid(write ? typeof csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(csrfToken) && body !== undefined
        : body === undefined && csrfToken === undefined && expectedVersion === undefined);
      valid(kind === 'request_transition' ? [1, 2].includes(expectedVersion) : expectedVersion === undefined);
      const payload = write ? JSON.stringify(body) : undefined;
      valid(payload === undefined || Buffer.byteLength(payload) <= 8192);
      signal.throwIfAborted(); const at = performance.now();
      const response = await fetch(new URL(path, url), { method, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), body: payload,
        headers: { Cookie: cookie, ...(write ? { Origin: url.origin, 'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken, ...(expectedVersion ? { 'If-Match': `"${expectedVersion}"` } : {}) } : {}) } });
      const chunks = []; let payloadBytes = 0;
      const reader = response.body?.getReader(); valid(reader);
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          payloadBytes += value.length;
          if (payloadBytes > (binary ? 2097152 : 8192)) { await reader.cancel(); throw new Error('LOAD_RESPONSE_TOO_LARGE'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, payloadBytes);
      const contentType = response.headers.get('content-type');
      if (binary) {
        valid(contentType === 'image/webp'
          && response.headers.get('cache-control') === 'private, no-cache, max-age=0, must-revalidate'
          && response.headers.get('vary') === 'Cookie' && response.headers.get('x-content-type-options') === 'nosniff'
          && /^"[a-f0-9]{64}"$/.test(response.headers.get('etag') ?? ''));
      } else valid(/^application\/json(?:; charset=utf-8)?$/i.test(contentType ?? ''));
      signal.throwIfAborted();
      return { status: response.status, body: binary ? bytes : JSON.parse(bytes.toString('utf8')), payloadBytes,
        requestPayloadBytes: payload === undefined ? 0 : Buffer.byteLength(payload), latencyMs: performance.now() - at };
    } catch { throw new Error('LOAD_BOOKING_TRANSPORT_FAILED'); }
  };
}

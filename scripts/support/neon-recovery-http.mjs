import http from 'node:http';
import { createHash } from 'node:crypto';
import { SESSION_COOKIE_NAME, SESSION_TOKEN_PATTERN } from '../../src/identity/session-cookie.js';
import { verifyMediaObjectBytes, MEDIA_OBJECT_MAX_BYTES } from '../../src/media/object-storage-contract.js';

const ORIGIN = 'https://customer.demo.test:4443';
const HOST = 'customer.demo.test:4443';
const SESSION = '/api/v1/demo/session';
const CONTEXT = `${SESSION}/context`;
export const RECOVERY_LOCATIONS_PATH = '/api/v1/tenant/settings/locations';
const ROOM_MEDIA = /^\/api\/v1\/tenant\/rooms\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/media\/[a-f0-9-]{36}$/;
const CATALOGUE_MEDIA = /^\/api\/v1\/demo\/media\/[a-f0-9-]{36}$/;
const REVISION = /^\/api\/v1\/tenant\/settings\/locations\/history\/\d{1,15}\?schemaVersion=3$/;
const ETAG = /^"[a-f0-9]{64}"$/;
const PRIVATE_CACHE_CONTROL = 'private, no-cache, max-age=0, must-revalidate';

function assertRoute(path, method) {
  if (typeof path !== 'string' || path.length > 256 || (method === 'GET'
    ? !(path === SESSION || path === `${RECOVERY_LOCATIONS_PATH}?schemaVersion=3`
      || path === `${RECOVERY_LOCATIONS_PATH}/history?limit=100` || REVISION.test(path)
      || ROOM_MEDIA.test(path) || CATALOGUE_MEDIA.test(path))
    : !(method === 'PUT' && [CONTEXT, RECOVERY_LOCATIONS_PATH].includes(path))
      && !(method === 'POST' && path === `${RECOVERY_LOCATIONS_PATH}/rollback`))) {
    throw new Error('NEON_RECOVERY_HTTP_ROUTE_INVALID');
  }
}

export function recoveryJson(response, expectedStatus = 200) {
  if (response.status !== expectedStatus || !/^application\/json(?:; charset=utf-8)?$/.test(response.headers['content-type'] || '')
    || response.bytes.length > 262144) throw new Error('NEON_RECOVERY_HTTP_RESPONSE_INVALID');
  let value;
  try { value = JSON.parse(response.bytes.toString('utf8')); } catch { throw new Error('NEON_RECOVERY_HTTP_RESPONSE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NEON_RECOVERY_HTTP_RESPONSE_INVALID');
  return value;
}

export function assertRecoveryHttpError(response, status, code) {
  const body = recoveryJson(response, status);
  if (Object.keys(body).join() !== 'error' || !body.error || Object.keys(body.error).sort().join() !== 'code,requestId'
    || body.error.code !== code || typeof body.error.requestId !== 'string' || body.error.requestId.length > 128
    || response.headers.etag !== undefined || !/\bno-store\b/.test(response.headers['cache-control'] || '')) {
    throw new Error('NEON_RECOVERY_HTTP_ERROR_INVALID');
  }
}

export function assertRecoveryHttpMedia(response, reference, expectedEtag = null) {
  if (response.status !== 200 || response.headers['content-type'] !== reference.contentType
    || response.headers['content-length'] !== String(reference.byteLength) || !ETAG.test(response.headers.etag || '')
    || response.headers['cache-control'] !== PRIVATE_CACHE_CONTROL
    || response.headers.vary !== 'Cookie' || response.headers['x-content-type-options'] !== 'nosniff'
    || (expectedEtag !== null && response.headers.etag !== expectedEtag)) {
    throw new Error('NEON_RECOVERY_HTTP_MEDIA_INVALID');
  }
  verifyMediaObjectBytes(response.bytes, reference);
  return Object.freeze({ etag: response.headers.etag,
    sha256: createHash('sha256').update(response.bytes).digest('hex'), byteLength: response.bytes.length });
}

export function assertRecoveryNotModified(response, etag) {
  if (response.status !== 304 || response.bytes.length !== 0 || response.headers.etag !== etag
    || response.headers['content-type'] !== undefined || response.headers['content-length'] !== undefined
    || response.headers.vary !== 'Cookie' || response.headers['cache-control'] !== PRIVATE_CACHE_CONTROL
    || response.headers['x-content-type-options'] !== 'nosniff') {
    throw new Error('NEON_RECOVERY_HTTP_CONDITIONAL_INVALID');
  }
}

// This is an operator HTTP probe of the running unmodified API, behind the same
// fixed Host/Origin used by the existing CI edge. It does not replace browser TLS,
// cookie, role or CSRF acceptance. No caller can choose an outbound destination.
export function createRecoveryHttpClient({ assertActive }, { request = http.request } = {}) {
  if (typeof assertActive !== 'function') throw new TypeError('NEON_RECOVERY_HTTP_CONTEXT_INVALID');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  let cookie = null;
  let csrf = null;
  let closed = false;
  let pending = false;

  function acceptCookie(headers) {
    const values = headers['set-cookie'];
    if (values === undefined) return;
    if (!Array.isArray(values) || values.length !== 1) throw new Error('NEON_RECOVERY_HTTP_SESSION_INVALID');
    const parts = values[0].split(';').map((part) => part.trim());
    const prefix = `${SESSION_COOKIE_NAME}=`;
    if (!parts[0].startsWith(prefix) || !SESSION_TOKEN_PATTERN.test(parts[0].slice(prefix.length))
      || !['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api'].every((part) => parts.includes(part))
      || parts.some((part) => /^Domain=/i.test(part))) throw new Error('NEON_RECOVERY_HTTP_SESSION_INVALID');
    cookie = parts[0];
  }

  async function send(path, { method = 'GET', body = null, etag = null } = {}) {
    assertActive();
    assertRoute(path, method);
    if (closed || pending || (etag !== null && etag !== '*' && !ETAG.test(etag))
      || (method !== 'GET' && (!cookie || !csrf))) throw new Error('NEON_RECOVERY_HTTP_REQUEST_INVALID');
    const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
    if ((method === 'GET' && bytes !== null) || (bytes && bytes.length > 65536)) {
      throw new Error('NEON_RECOVERY_HTTP_REQUEST_INVALID');
    }
    const headers = { Host: HOST, Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
      ...(etag === null ? {} : { 'If-None-Match': etag }),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }),
      ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } : {}) };
    pending = true;
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port: 3000, method, path, headers, agent, maxHeaderSize: 16384 },
          (response) => {
            const chunks = [];
            let size = 0;
            let oversized = false;
            response.on('data', (chunk) => {
              if (oversized) return;
              size += chunk.length;
              if (size > MEDIA_OBJECT_MAX_BYTES) {
                oversized = true;
                reject(new Error('NEON_RECOVERY_HTTP_RESPONSE_INVALID'));
                response.destroy();
                outgoing.destroy(new Error('NEON_RECOVERY_HTTP_RESPONSE_INVALID'));
              } else chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('end', () => {
              if (!oversized) resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks, size) });
            });
          });
        timer = setTimeout(() => {
          reject(new Error('NEON_RECOVERY_HTTP_TIMEOUT'));
          outgoing.destroy(new Error('NEON_RECOVERY_HTTP_TIMEOUT'));
        }, 5000);
        outgoing.once('error', reject);
        outgoing.end(bytes);
      });
      if ([SESSION, CONTEXT].includes(path)) acceptCookie(result.headers);
      return result;
    } catch { throw new Error('NEON_RECOVERY_HTTP_FAILED'); }
    finally { clearTimeout(timer); pending = false; }
  }

  return Object.freeze({
    request: send,
    async establish(tenantId) {
      if (!/^[a-f0-9-]{36}$/.test(tenantId || '')) throw new Error('NEON_RECOVERY_HTTP_SESSION_INVALID');
      for (const [path, options] of [[SESSION, {}], [CONTEXT, { method: 'PUT',
        body: { tenantId, persona: 'conference_manager' } }]]) {
        const result = recoveryJson(await send(path, options));
        if (!cookie || !SESSION_TOKEN_PATTERN.test(result.csrfToken || '')) throw new Error('NEON_RECOVERY_HTTP_SESSION_INVALID');
        csrf = result.csrfToken;
        if (path === CONTEXT && (result.tenant?.id !== tenantId || result.demo?.persona !== 'conference_manager')) {
          throw new Error('NEON_RECOVERY_HTTP_SESSION_INVALID');
        }
      }
    },
    close() { closed = true; cookie = null; csrf = null; agent.destroy(); },
  });
}

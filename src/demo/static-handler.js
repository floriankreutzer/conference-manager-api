import { matchesEntityTag, selectStaticEncoding } from '../transport/conditional-get.js';

const SURFACES = new Set(['customer', 'platform']);
const REQUEST_TARGET_LIMIT = 8_192;
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const CUSTOMER_STYLE_SOURCES = Object.freeze([
  "'self'",
  "'sha256-IwFkyCVIyurW9bJF80THrt85tGm07bI5WVzgH12f8GE='",
  "'sha256-/ZJyhxwkFy8aRB7cj/3aOjLSm85p3cPyLmPldxKhD3s='",
]);
const COMMON_CSP_DIRECTIVES = Object.freeze([
  "script-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "worker-src 'none'",
  "frame-ancestors 'none'",
]);
const CONTENT_SECURITY_POLICIES = Object.freeze({
  customer: [
    "default-src 'self'",
    `style-src ${CUSTOMER_STYLE_SOURCES.join(' ')}`,
    ...COMMON_CSP_DIRECTIVES,
  ].join('; '),
  platform: [
    "default-src 'self'",
    "style-src 'self'",
    ...COMMON_CSP_DIRECTIVES,
  ].join('; '),
});

function safePathname(rawUrl) {
  if (
    typeof rawUrl !== 'string'
    || !rawUrl
    || rawUrl.length > REQUEST_TARGET_LIMIT
    || !rawUrl.startsWith('/')
    || rawUrl.startsWith('//')
    || /\\|\0|%2f|%5c/i.test(rawUrl.split('?', 1)[0])
  ) return null;

  let pathname;
  try {
    pathname = new URL(rawUrl, 'demo://local').pathname;
  } catch {
    return null;
  }

  let decoded = pathname;
  for (let index = 0; index < 2; index += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  }
  return decoded;
}

function assetPath(surface, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return surface === 'platform' ? 'platform-admin-demo/index.html' : 'index.html';
  }
  if (surface === 'platform' && (
    pathname === '/platform-admin-demo/'
    || pathname === '/platform-admin-demo/index.html'
  )) return 'platform-admin-demo/index.html';
  if (pathname.startsWith('/assets/') || pathname.startsWith('/src/')) return pathname.slice(1);
  return null;
}

function extensionOf(relativePath) {
  const match = relativePath.match(/\.[A-Za-z0-9]+$/);
  return match ? match[0].toLowerCase() : null;
}

function applyStaticHeaders(response, { surface, contentType, contentLength }) {
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICIES[surface]);
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  if (contentType) response.setHeader('Content-Type', contentType);
  if (contentLength !== undefined) response.setHeader('Content-Length', contentLength);
}

function sendEmpty(response, surface, statusCode, headers = {}) {
  applyStaticHeaders(response, { surface, contentLength: 0 });
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.statusCode = statusCode;
  response.end();
}

export function createDemoStaticHandler({ root, surface, fileAdapter } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('DEMO_STATIC_ROOT_REQUIRED');
  if (!SURFACES.has(surface)) throw new TypeError('DEMO_STATIC_SURFACE_INVALID');
  if (!fileAdapter || typeof fileAdapter.open !== 'function' || typeof fileAdapter.pipe !== 'function') {
    throw new TypeError('DEMO_STATIC_FILE_ADAPTER_REQUIRED');
  }

  return async function handleDemoStatic(request, response) {
    const pathname = safePathname(request?.url);
    if (!pathname) {
      sendEmpty(response, surface, 400);
      return;
    }
    const relativePath = assetPath(surface, pathname);
    if (!relativePath) {
      sendEmpty(response, surface, 404);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      sendEmpty(response, surface, 405, { Allow: 'GET, HEAD' });
      return;
    }

    const file = await fileAdapter.open(relativePath);
    if (file?.kind === 'invalid') {
      sendEmpty(response, surface, 400);
      return;
    }
    if (file?.kind === 'too_large') { sendEmpty(response, surface, 413); return; }
    if (file?.kind !== 'file') {
      sendEmpty(response, surface, 404);
      return;
    }

    const contentType = CONTENT_TYPES[extensionOf(relativePath)];
    if (!contentType) {
      sendEmpty(response, surface, 415);
      return;
    }
    if (typeof fileAdapter.representation === 'function') {
      const compressible = /^(?:text\/|application\/json|image\/svg\+xml)/.test(contentType) && file.size <= 1048576;
      const encoding = selectStaticEncoding(request.headers['accept-encoding'], { compressible });
      if (encoding === null) { sendEmpty(response, surface, 406, { Vary: 'Accept-Encoding' }); return; }
      const representation = await fileAdapter.representation(file, { encoding });
      if (!Buffer.isBuffer(representation?.bytes) || representation.bytes.length > 8388608
        || representation.encoding !== encoding || !/^[a-f0-9]{64}$/.test(representation.digest)
        || !/^"[a-f0-9]{64}"$/.test(representation.etag)) throw new TypeError('DEMO_STATIC_REPRESENTATION_INVALID');
      const query = new URL(request.url, 'demo://local').searchParams;
      const requestedDigest = query.get('sha256');
      const immutable = query.size === 1 && /^[a-f0-9]{64}$/.test(requestedDigest || '')
        && requestedDigest === representation.digest;
      if (requestedDigest !== null && !immutable) { sendEmpty(response, surface, 404); return; }
      applyStaticHeaders(response, { surface, contentType });
      response.setHeader('ETag', representation.etag);
      response.setHeader('Vary', 'Accept-Encoding');
      if (immutable) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding);
      if (matchesEntityTag(request.headers['if-none-match'], representation.etag)) {
        response.statusCode = 304; response.end(); return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Length', representation.bytes.length);
      response.end(request.method === 'HEAD' ? undefined : representation.bytes);
      return;
    }
    applyStaticHeaders(response, {
      surface,
      contentType,
      contentLength: file.size,
    });
    response.statusCode = 200;
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    try {
      await fileAdapter.pipe(file, response);
    } catch (error) {
      if (!response.destroyed) response.destroy(error);
    }
  };
}

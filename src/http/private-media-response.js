import { createHash } from 'node:crypto';
import { matchesEntityTag } from '../transport/conditional-get.js';

const MAX_BYTES = 2 * 1024 * 1024;

// Call only after current session, Tenant and attachment/owner authorization and verified
// media loading. Every cache reuse is revalidated; a conditional header grants no authority.
export function sendPrivateMediaResponse({ request, response, tenantId, assetId, contentType, bytes }) {
  if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 128
    || typeof assetId !== 'string' || !assetId || assetId.length > 128
    || !['image/png', 'image/webp'].includes(contentType)
    || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES) {
    throw new TypeError('PRIVATE_MEDIA_RESPONSE_INVALID');
  }
  const etag = `"${createHash('sha256').update(JSON.stringify([tenantId, assetId, contentType]))
    .update(bytes).digest('hex')}"`;
  response.setHeader('ETag', etag);
  response.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
  response.setHeader('Vary', 'Cookie');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (matchesEntityTag(request.headers['if-none-match'], etag)) {
    response.statusCode = 304;
    response.end();
    return 304;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', bytes.length);
  response.end(bytes);
  return 200;
}

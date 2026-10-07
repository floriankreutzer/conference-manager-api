import { ApiError } from '../api-error.js';
import { RoomImageInputError, ROOM_IMAGE_INPUT_MAX_BYTES } from '../media/room-image-processor.js';
import { defineRouteModule } from './route-module.js';
import { sendPrivateMediaResponse } from './private-media-response.js';

const MEDIA_PATH = /^\/api\/v1\/tenant\/rooms\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/media(?:\/([0-9a-fA-F-]{36}))?$/;

async function emptyBody(request) {
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}

async function imageBody(request) {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined && (
    Array.isArray(contentLength) || !/^\d+$/.test(contentLength)
    || Number(contentLength) < 1 || Number(contentLength) > ROOM_IMAGE_INPUT_MAX_BYTES
  )) throw new ApiError(413, 'TENANT_ROOM_MEDIA_INVALID');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > ROOM_IMAGE_INPUT_MAX_BYTES) throw new ApiError(413, 'TENANT_ROOM_MEDIA_INVALID');
    chunks.push(chunk);
  }
  if (length === 0 || (contentLength !== undefined && length !== Number(contentLength))) {
    throw new ApiError(400, 'TENANT_ROOM_MEDIA_INVALID');
  }
  return Buffer.concat(chunks, length);
}

export function roomMediaRouteKey(path) {
  return MEDIA_PATH.test(path) ? 'tenant_room_media' : null;
}

export function createRoomMediaHttpHandler({ service, principalGuard, tenantGuard } = {}) {
  if (!principalGuard?.require || !tenantGuard?.requireKnown) {
    throw new TypeError('ROOM_MEDIA_GUARDS_REQUIRED');
  }
  return async function handleRoomMedia({ request, response, parsedUrl, path, requestId }) {
    const match = path.match(MEDIA_PATH);
    if (!match) return null;
    if (!service) throw new ApiError(503, 'ROOM_MEDIA_UNAVAILABLE');
    if ([...parsedUrl.searchParams].length !== 0) throw new ApiError(400, 'VALIDATION_FAILED');
    const upload = match[2] === undefined;
    if (request.method !== (upload ? 'POST' : 'GET')) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    const principal = await principalGuard.require(request, { csrf: upload });
    const tenantContext = await tenantGuard.requireKnown(principal);
    if (upload) {
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');
      }
      try {
        const result = await service.upload({
          principal, tenantContext, correlationId: requestId, roomId: match[1], contentType,
          bytes: await imageBody(request),
        });
        if (result === null) throw new ApiError(404, 'NOT_FOUND');
        if (result.status === 'quota_exceeded') throw new ApiError(413, 'TENANT_ROOM_MEDIA_QUOTA_EXCEEDED');
        const body = JSON.stringify({ assetId: result.assetId });
        response.statusCode = 201;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('Content-Length', Buffer.byteLength(body));
        response.end(body);
        return 201;
      } catch (error) {
        if (error instanceof RoomImageInputError) throw new ApiError(400, error.code);
        throw error;
      }
    }
    await emptyBody(request);
    const asset = await service.read({ principal, tenantContext, roomId: match[1], assetId: match[2] });
    if (!asset) throw new ApiError(404, 'NOT_FOUND');
    return sendPrivateMediaResponse({ request, response, tenantId: tenantContext.tenantId,
      assetId: match[2], contentType: 'image/webp', bytes: asset.bytes });
  };
}

export const roomMediaRoutes = defineRouteModule({
  id: 'room-media',
  routeKey: roomMediaRouteKey,
  createHandler(runtime) {
    return createRoomMediaHttpHandler({
      service: runtime.roomMediaService,
      principalGuard: runtime.principalGuard,
      tenantGuard: runtime.tenantGuard,
    });
  },
});

import sharp from 'sharp';

export const ROOM_IMAGE_INPUT_MAX_BYTES = 2 * 1024 * 1024;
export const ROOM_IMAGE_MAX_PIXELS = 4_000_000;
const CONTENT_TYPES = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

export class RoomImageInputError extends Error {
  constructor() {
    super('TENANT_ROOM_MEDIA_INVALID');
    this.name = 'RoomImageInputError';
    this.code = 'TENANT_ROOM_MEDIA_INVALID';
  }
}

function invalid() {
  throw new RoomImageInputError();
}

// Only decoded raster pixels cross this boundary; encoded source bytes and metadata
// must never reach persistence or a browser response.
export async function processRoomImage({ bytes, contentType } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > ROOM_IMAGE_INPUT_MAX_BYTES
    || !Object.values(CONTENT_TYPES).includes(contentType)) invalid();

  try {
    const decoder = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: ROOM_IMAGE_MAX_PIXELS,
      pages: 1,
      animated: false,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    if (CONTENT_TYPES[metadata.format] !== contentType || metadata.pages > 1
      || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
      || metadata.width < 1 || metadata.height < 1
      || metadata.width * metadata.height > ROOM_IMAGE_MAX_PIXELS) invalid();

    // A newly encoded WebP has no source EXIF, ICC, XMP or IPTC metadata by default.
    const output = await decoder.rotate().webp({ quality: 80, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (output.data.length > ROOM_IMAGE_INPUT_MAX_BYTES
      || output.info.width * output.info.height > ROOM_IMAGE_MAX_PIXELS) invalid();
    return Object.freeze({
      bytes: output.data,
      contentType: 'image/webp',
      width: output.info.width,
      height: output.info.height,
    });
  } catch {
    invalid();
  }
}

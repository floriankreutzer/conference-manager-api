import { createHash } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';

export const MEDIA_OBJECT_MAX_BYTES = 2 * 1024 * 1024;
const KINDS = new Set(['room', 'catalogue']);
const TYPES = new Set(['image/webp', 'image/png']);

export class MediaObjectStorageError extends Error {
  constructor(code = 'MEDIA_STORAGE_UNAVAILABLE') {
    super(code);
    this.name = 'MediaObjectStorageError';
    this.code = code;
  }
}

// Ownership must already have been authorized against authoritative PostgreSQL metadata.
// Neither an arbitrary key nor a URL is accepted at this port.
export function mediaObjectReference({ tenantId, assetId, kind, sha256, byteLength, contentType }) {
  if (!isInternalUuid(tenantId) || !isInternalUuid(assetId) || !KINDS.has(kind)
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)
    || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MEDIA_OBJECT_MAX_BYTES
    || !TYPES.has(contentType) || (kind === 'room' && contentType !== 'image/webp')) {
    throw new TypeError('MEDIA_OBJECT_REFERENCE_INVALID');
  }
  return Object.freeze({ tenantId, assetId, kind, sha256, byteLength, contentType,
    key: `v1/${tenantId}/${kind}/${assetId}/${sha256}` });
}

export function verifyMediaObjectBytes(bytes, reference) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== reference.byteLength
    || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
    throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
  }
  return bytes;
}

import { mediaObjectReference, verifyMediaObjectBytes, MediaObjectStorageError } from '../../media/object-storage-contract.js';

function fixtureReference(tenantId, media, kind) {
  return mediaObjectReference({ tenantId, assetId: media.id, kind,
    contentType: kind === 'room' ? 'image/webp' : media.contentType,
    byteLength: media.byteLength, sha256: media.sha256 });
}

// The reset repository validates the complete canonical fixture/checksum and live reset
// authority before requesting these independently committed, provider-free intents.
export function demoFixtureMediaReferences(fixture) {
  return Object.freeze(fixture.tenants.flatMap((tenant) => [
    ...tenant.roomMedia.map((media) => fixtureReference(tenant.id, media, 'room')),
    ...tenant.catalogueMedia.map((media) => fixtureReference(tenant.id, media, 'catalogue')),
  ]));
}

export async function publishDemoFixtureMedia(client, tenantId, media, kind, bytes, mediaObjects) {
  if (!mediaObjects) return null;
  const reference = fixtureReference(tenantId, media, kind);
  verifyMediaObjectBytes(bytes, reference);
  const key = await mediaObjects.putWithClient(client, reference, bytes);
  if (key !== reference.key) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
  return key;
}

export async function readDemoFixtureMediaBytes(row, kind, mediaObjects) {
  if (!Buffer.isBuffer(row.content_sha256)) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
  const reference = mediaObjectReference({ tenantId: row.tenant_id, assetId: row.id, kind,
    contentType: row.content_type, byteLength: row.byte_length, sha256: row.content_sha256.toString('hex') });
  if (row.object_key) {
    if (row.object_key !== reference.key) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
    if (!mediaObjects) throw new MediaObjectStorageError();
    return verifyMediaObjectBytes(await mediaObjects.read(reference, row.object_key), reference);
  }
  if (mediaObjects) throw new MediaObjectStorageError('MEDIA_STORAGE_BACKFILL_REQUIRED');
  return row.bytes;
}

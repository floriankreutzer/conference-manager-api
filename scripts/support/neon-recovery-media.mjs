import { createHash } from 'node:crypto';
import { mediaObjectReference, verifyMediaObjectBytes } from '../../src/media/object-storage-contract.js';
import { forEachDemoMediaBatch } from '../../src/persistence/postgres/demo-fixture-media.js';
import { RECOVERY_MANIFEST } from './neon-recovery-config.mjs';

export function restoredMediaReferences(rows) {
  if (!Array.isArray(rows) || rows.length !== 34 || rows.filter(({ kind }) => kind === 'room').length !== 11) {
    throw new Error('NEON_RECOVERY_MEDIA_INVALID');
  }
  const references = rows.map((row) => {
    const reference = mediaObjectReference({ tenantId: row.tenant_id, assetId: row.id, kind: row.kind,
      contentType: row.content_type, byteLength: row.byte_length, sha256: row.sha256 });
    if (row.blob_valid !== true || row.object_key !== reference.key || row.inventory_key !== reference.key
      || row.inventory_length !== reference.byteLength || row.inventory_sha256 !== reference.sha256
      || row.inventory_type !== reference.contentType || row.inventory_tenant !== reference.tenantId
      || row.inventory_asset !== reference.assetId || row.inventory_kind !== reference.kind) {
      throw new Error('NEON_RECOVERY_MEDIA_INVALID');
    }
    return reference;
  });
  const manifest = references.map(({ key, sha256, byteLength }) => ({ key, sha256, size: byteLength }));
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (digest !== RECOVERY_MANIFEST) throw new Error('NEON_RECOVERY_MANIFEST_INVALID');
  return Object.freeze({ references: Object.freeze(references), manifest: Object.freeze(manifest), digest });
}

export async function verifyRestoredProviderBytes(storage, references) {
  await forEachDemoMediaBatch(references, async (reference) => verifyMediaObjectBytes(await storage.get(reference), reference));
}

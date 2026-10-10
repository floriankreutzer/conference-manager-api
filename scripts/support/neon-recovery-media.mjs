import { createHash } from 'node:crypto';
import { mediaObjectReference, verifyMediaObjectBytes } from '../../src/media/object-storage-contract.js';
import { forEachDemoMediaBatch } from '../../src/persistence/postgres/demo-fixture-media.js';
import { RECOVERY_MANIFEST } from './neon-recovery-config.mjs';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM, createDemoResetGenerationFixture,
  assertSemanticChecksum, semanticChecksum } from '../../src/demo/fixture.js';

export function verifyRestoredSemanticState(state) {
  const expected = state?.fixedClock === DEMO_FIXTURE.fixedClock
    ? DEMO_FIXTURE_CHECKSUM
    : semanticChecksum(createDemoResetGenerationFixture(DEMO_FIXTURE, new Date(state?.fixedClock)));
  return assertSemanticChecksum(state, expected);
}

export async function readRestoredMediaReferences(client) {
  const result = await client.query(`SELECT a.*, i.object_key AS inventory_key,
    i.byte_length AS inventory_length, encode(i.content_sha256, 'hex') AS inventory_sha256,
    i.content_type AS inventory_type, i.tenant_id AS inventory_tenant, i.asset_id AS inventory_asset, i.kind AS inventory_kind
    FROM (SELECT tenant_id, id, 'room' AS kind, content_type, byte_length, object_key,
      encode(content_sha256, 'hex') AS sha256, bytes IS NOT NULL AND octet_length(bytes) = byte_length
      AND sha256(bytes) = content_sha256 AS blob_valid FROM public.tenant_room_media_assets
      UNION ALL SELECT tenant_id, id, 'catalogue', content_type, byte_length, object_key,
      encode(content_sha256, 'hex'), bytes IS NOT NULL AND octet_length(bytes) = byte_length
      AND sha256(bytes) = content_sha256 FROM public.demo_catalogue_media_assets) a
    LEFT JOIN public.media_object_inventory i ON i.object_key = a.object_key ORDER BY a.object_key LIMIT 35`);
  return restoredMediaReferences(result.rows);
}

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

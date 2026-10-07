import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createCiMediaStorageServer, createCiMediaObjectStorage } from '../scripts/support/ci-media-storage.mjs';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';

const token = 'a'.repeat(64);
const bytes = Buffer.from('bounded CI object bytes');
const reference = mediaObjectReference({ tenantId: '11111111-1111-4111-8111-111111111111',
  assetId: '22222222-2222-4222-8222-222222222222', kind: 'room', contentType: 'image/webp',
  byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

test('the real SDK and private adapter roundtrip through bounded isolated test-only S3 transport', async () => {
  const service = createCiMediaStorageServer({ token, port: 0 });
  const { port } = await service.start();
  const storage = createCiMediaObjectStorage({ token, port });
  try {
    await assert.rejects(storage.get(reference), { code: 'MEDIA_STORAGE_OBJECT_MISSING' });
    assert.equal(await storage.put(reference, bytes), reference.key);
    assert.deepEqual(await storage.get(reference), bytes);
    const foreign = mediaObjectReference({ ...reference, tenantId: '33333333-3333-4333-8333-333333333333' });
    await assert.rejects(storage.get(foreign), { code: 'MEDIA_STORAGE_OBJECT_MISSING' });
    await storage.remove(reference);
    await storage.remove(reference);
    await assert.rejects(storage.get(reference), { code: 'MEDIA_STORAGE_OBJECT_MISSING' });
  } finally { storage.close(); await service.close(); }
});

test('loopback object transport requires ephemeral authority and rejects invalid bytes before I/O', async () => {
  const service = createCiMediaStorageServer({ token, port: 0 });
  const { port } = await service.start();
  const storage = createCiMediaObjectStorage({ token, port });
  const denied = createCiMediaObjectStorage({ token: 'b'.repeat(64), port });
  let calls = 0;
  service.server.on('request', () => { calls += 1; });
  try {
    await assert.rejects(storage.put(reference, Buffer.from('corrupt')), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
    assert.equal(calls, 0);
    await assert.rejects(denied.get(reference), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
    assert.equal(calls, 1);
    assert.throws(() => createCiMediaObjectStorage({ token: 'invalid', port }), /AUTHORITY_REQUIRED/);
    assert.throws(() => createCiMediaObjectStorage({ token, port: 0 }), /PORT_INVALID/);
  } finally { storage.close(); denied.close(); await service.close(); }
});

test('CI object entrypoint cannot activate test storage in Demo or production', () => {
  for (const mode of ['production', 'demo']) {
    const result = spawnSync(process.execPath, ['scripts/demo-object-acceptance.mjs', 'storage'], {
      env: { ...process.env, NODE_ENV: mode }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_OBJECT_ACCEPTANCE_TEST_MODE_REQUIRED/);
  }
});

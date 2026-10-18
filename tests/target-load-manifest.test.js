import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile, chmod, unlink, symlink } from 'node:fs/promises';
import test from 'node:test';
import { validateTargetLoadManifest, readTargetLoadManifest } from '../scripts/support/target-load-manifest.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';
import { targetLoadManifest } from './support/target-load-manifest.js';

const values = targetScopeValues(targetLoadSetupEnvironment());
test('private manifest binds run/source/expiry, canonical origins, actor custody and exact synthetic catalogue', async () => {
  const value = await targetLoadManifest(); const checked = validateTargetLoadManifest(value, values, NOW);
  assert.deepEqual(checked, value); assert.notEqual(checked.employees, value.employees);
  for (const corrupt of [row => { row.password = 'private'; }, row => { row.releaseSha = 'f'.repeat(40); },
    row => { row.origins.customer = 'https://foreign.invalid'; }, row => { row.tenants[1] = row.tenants[0]; },
    row => { row.employees[0].roles = ['conference_manager']; }, row => { row.employees[0].tenantId = row.tenants[1]; },
    row => { row.employees[1].cookie = row.employees[0].cookie; }, row => { row.employees[0].providerKey = 'private'; },
    row => { row.images[0].byteLength = 2 ** 31; }, row => { row.storageProbe.assetId = row.images[1].assetId; },
    row => { row.expectedRooms[0][0].mediaAssetIds = [row.images[1].assetId]; },
    row => { row.configurations[0].revisions.organization = 0; }]) {
    const bad = structuredClone(value); corrupt(bad);
    assert.throws(() => validateTargetLoadManifest(bad, values, NOW), /^Error: LOAD_TARGET_MANIFEST_FAILED$/);
  }
});

test('manifest reader rejects permissive files and symlinks and bounds private input before parse', async t => {
  const runId = randomBytes(8).toString('hex'); const env = targetLoadSetupEnvironment(runId);
  const scoped = targetScopeValues(env); const path = `/tmp/cm-saas38-load-${runId}.json`;
  t.after(() => unlink(path).catch(() => {})); const value = await targetLoadManifest({ runId });
  await writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await readTargetLoadManifest(scoped, { clock: () => NOW }), value);
  await chmod(path, 0o644); await assert.rejects(readTargetLoadManifest(scoped, { clock: () => NOW }));
  await chmod(path, 0o600); await writeFile(path, Buffer.alloc(5_000_001));
  await assert.rejects(readTargetLoadManifest(scoped, { clock: () => NOW }));
  await unlink(path); await symlink('/etc/passwd', path);
  await assert.rejects(readTargetLoadManifest(scoped, { clock: () => NOW }), /^Error: LOAD_TARGET_MANIFEST_FAILED$/);
});

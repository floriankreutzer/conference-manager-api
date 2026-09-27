import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Room media retention requires explicit execution and a separate database identity', () => {
  const env = { ...process.env };
  delete env.ROOM_MEDIA_RETENTION_DATABASE_URL;
  const disabled = spawnSync(process.execPath, ['scripts/room-media-retention.mjs'], {
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /ROOM_MEDIA_RETENTION_EXECUTE_REQUIRED/);
  const missingIdentity = spawnSync(process.execPath, ['scripts/room-media-retention.mjs', '--execute'], {
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(missingIdentity.status, 1);
  assert.match(missingIdentity.stderr, /ROOM_MEDIA_RETENTION_DATABASE_REQUIRED/);
});

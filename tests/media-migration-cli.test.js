import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(args) {
  const env = { ...process.env };
  delete env.MEDIA_MIGRATION_DATABASE_URL;
  delete env.MEDIA_MIGRATION_DATABASE_ROLE;
  return spawnSync(process.execPath, ['scripts/private-media-migration.mjs', ...args], {
    env, encoding: 'utf8', timeout: 10_000,
  });
}

test('private migration refuses implicit execution, broad phases/kinds and purge without retained evidence', () => {
  for (const args of [[], ['--execute'], ['--execute', 'delete', 'room'], ['--execute', 'copy', 'all'],
    ['--execute', 'purge', 'room'], ['--execute', 'copy', 'room', 'ignored'],
    ['--execute', 'purge', 'room', '--restore-evidence-sha256=invalid']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MEDIA_MIGRATION_EXECUTE_CONTRACT_REQUIRED/);
  }
});

test('private migration requires a separate operator identity before provider credentials or network access', () => {
  for (const args of [['--execute', 'copy', 'room'], ['--execute', 'rollback', 'catalogue'],
    ['--execute', 'purge', 'room', `--restore-evidence-sha256=${'a'.repeat(64)}`]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MEDIA_MIGRATION_SEPARATE_OPERATOR_IDENTITY_REQUIRED/);
    assert.doesNotMatch(result.stderr, /secret|s3_secret|postgres:\/\//);
  }
});

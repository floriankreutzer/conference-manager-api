import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { closeNeonRecoveryResources } from '../scripts/support/neon-recovery-cleanup.mjs';

test('recovery cleanup awaits each resource in order and preserves the existing exit code', async () => {
  const calls = [];
  const exitCode = process.exitCode;
  const result = await closeNeonRecoveryResources([
    async () => { await Promise.resolve(); calls.push('composition'); },
    () => { calls.push('storage'); },
  ]);
  assert.equal(result, true);
  assert.deepEqual(calls, ['composition', 'storage']);
  assert.equal(process.exitCode, exitCode);
});

test('recovery cleanup redacts synchronous throws and rejects while closing every remaining resource', () => {
  const source = `
    import { closeNeonRecoveryResources } from './scripts/support/neon-recovery-cleanup.mjs';
    const calls = [];
    const result = await closeNeonRecoveryResources([
      () => { calls.push('client'); throw new Error('private-dsn-diagnostic'); },
      async () => { calls.push('pool'); throw new Error('private-provider-diagnostic'); },
      () => { calls.push('storage'); },
    ]);
    const subsequent = await closeNeonRecoveryResources([() => { calls.push('subsequent'); }]);
    process.stdout.write(JSON.stringify({ result, subsequent, calls, exitCode: process.exitCode }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'NEON_RECOVERY_CLEANUP_FAILED\n');
  assert.deepEqual(JSON.parse(result.stdout), { result: false, subsequent: true,
    calls: ['client', 'pool', 'storage', 'subsequent'], exitCode: 1 });
});

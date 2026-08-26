import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function run(path, ...options) {
  return spawnSync(process.execPath, ['scripts/pilot-readiness.mjs', path, ...options], {
    encoding: 'utf8',
  });
}

test('Pilot readiness CLI reads bounded evidence and emits only the minimized summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-manager-readiness-'));
  const evidencePath = join(directory, 'evidence.json');
  try {
    const example = await readFile('docs/pilot-readiness-evidence.example.json', 'utf8');
    await writeFile(evidencePath, example, { mode: 0o600 });
    const result = run(evidencePath);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'validated');
    assert.equal(summary.ready, false);
    assert.equal(summary.enabledCalendarWriteEvidenceVerified, false);
    assert.ok(Array.isArray(summary.pending));
    assert.deepEqual(Object.keys(summary).sort(), [
      'enabledCalendarWriteEvidenceVerified',
      'notApplicable',
      'pending',
      'ready',
      'status',
      'verifiedCount',
    ]);
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pilot readiness CLI rejects symlink, oversized and malformed evidence with stable codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-manager-readiness-'));
  const evidencePath = join(directory, 'evidence.json');
  const linkPath = join(directory, 'evidence-link.json');
  const oversizedPath = join(directory, 'oversized.json');
  const malformedPath = join(directory, 'malformed.json');
  try {
    await writeFile(evidencePath, '{}\n', { mode: 0o600 });
    await symlink(evidencePath, linkPath);
    await writeFile(oversizedPath, 'x'.repeat(65_537), { mode: 0o600 });
    await writeFile(malformedPath, '{not-json}\n', { mode: 0o600 });

    for (const path of [linkPath, oversizedPath]) {
      const result = run(path);
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), {
        status: 'failed',
        code: 'PILOT_READINESS_FILE_INVALID',
      });
    }
    const malformed = run(malformedPath);
    assert.equal(malformed.status, 1);
    assert.deepEqual(JSON.parse(malformed.stderr), {
      status: 'failed',
      code: 'PILOT_READINESS_JSON_INVALID',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

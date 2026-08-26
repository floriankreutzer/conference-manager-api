import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function validEvidence() {
  return {
    schemaVersion: 1,
    verifiedAt: '2026-08-26T10:00:00.000Z',
    centralAppRegistration: { calendarsReadWriteRequested: false },
    customerServicePrincipal: { unscopedCalendarsReadWriteGranted: false },
    configuredRoomIds: ['room-a'],
    authorizationChecks: [
      { roomId: 'room-a', roleName: 'Application Calendars.ReadWrite', inScope: true },
    ],
    negativeControl: { roleName: 'Application Calendars.ReadWrite', inScope: false },
  };
}

test('Exchange RBAC operator check prints only a non-sensitive summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-manager-rbac-'));
  const evidencePath = join(directory, 'evidence.json');
  try {
    await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      'scripts/exchange-application-rbac-check.mjs',
      evidencePath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'verified',
      configuredRoomCount: 1,
      inScopeRoomCount: 1,
      negativeControlDenied: true,
      unscopedWriteAbsent: true,
    });
    assert.equal(result.stdout.includes('room-a'), false);
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Exchange RBAC operator check fails closed without echoing rejected input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-manager-rbac-'));
  const evidencePath = join(directory, 'evidence.json');
  try {
    const rejected = { ...validEvidence(), accessToken: 'sensitive-marker' };
    await writeFile(evidencePath, `${JSON.stringify(rejected)}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      'scripts/exchange-application-rbac-check.mjs',
      evidencePath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      status: 'failed',
      code: 'EXCHANGE_APPLICATION_RBAC_DOCUMENT_INVALID',
    });
    assert.equal(`${result.stdout}${result.stderr}`.includes('sensitive-marker'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Exchange RBAC operator check refuses symbolic links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-manager-rbac-'));
  const evidencePath = join(directory, 'evidence.json');
  const linkPath = join(directory, 'evidence-link.json');
  try {
    await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, { mode: 0o600 });
    await symlink(evidencePath, linkPath);
    const result = spawnSync(process.execPath, [
      'scripts/exchange-application-rbac-check.mjs',
      linkPath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      status: 'failed',
      code: 'EXCHANGE_APPLICATION_RBAC_FILE_OR_JSON_INVALID',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Exchange RBAC operator check enforces the processing bound on the opened file descriptor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-manager-rbac-'));
  const evidencePath = join(directory, 'evidence.json');
  try {
    await writeFile(evidencePath, 'x'.repeat(65_537), { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      'scripts/exchange-application-rbac-check.mjs',
      evidencePath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      status: 'failed',
      code: 'EXCHANGE_APPLICATION_RBAC_FILE_OR_JSON_INVALID',
    });

    const [source, reader] = await Promise.all([
      readFile('scripts/exchange-application-rbac-check.mjs', 'utf8'),
      readFile('scripts/lib/bounded-evidence-file.mjs', 'utf8'),
    ]);
    assert.match(source, /readBoundedRegularFile/);
    assert.match(reader, /Buffer\.allocUnsafe\(maxBytes \+ 1\)/);
    assert.match(reader, /file\.read\(buffer,/);
    assert.doesNotMatch(reader, /file\.readFile/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

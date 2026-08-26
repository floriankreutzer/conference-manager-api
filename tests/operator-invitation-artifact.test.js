import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareInvitationArtifact } from '../scripts/operator-invitation-artifact.mjs';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const INVITATION_TOKEN = 'A'.repeat(43);

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'conference-manager-operator-'));
}

test('invitation artifact is exclusive, mode 0600 and atomically finalized', async () => {
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'invitation.json');
  try {
    const artifact = await prepareInvitationArtifact({
      outputPath,
      tokenFactory: () => INVITATION_TOKEN,
    });
    const prepared = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(prepared, {
      schemaVersion: 1,
      status: 'prepared',
      invitationToken: INVITATION_TOKEN,
    });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);

    await artifact.finalize({
      invitationResult: {
        tenantId: TENANT_ID,
        invitationToken: INVITATION_TOKEN,
        expiresAt: '2026-08-27T08:00:00.000Z',
      },
      correlationId: CORRELATION_ID,
    });
    const finalized = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(finalized, {
      schemaVersion: 1,
      status: 'created',
      tenantId: TENANT_ID,
      invitationToken: INVITATION_TOKEN,
      expiresAt: '2026-08-27T08:00:00.000Z',
      correlationId: CORRELATION_ID,
    });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invitation artifact never overwrites an existing file', async () => {
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'invitation.json');
  try {
    await writeFile(outputPath, 'preserve', { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(
      prepareInvitationArtifact({
        outputPath,
        tokenFactory: () => INVITATION_TOKEN,
      }),
      (error) => error?.code === 'TENANT_OPERATOR_OUTPUT_EXISTS',
    );
    assert.equal(await readFile(outputPath, 'utf8'), 'preserve');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed invitation persistence can remove the prepared credential artifact', async () => {
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'invitation.json');
  try {
    const artifact = await prepareInvitationArtifact({
      outputPath,
      tokenFactory: () => INVITATION_TOKEN,
    });
    await artifact.abort();
    await assert.rejects(stat(outputPath), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid invitation credentials are rejected before filesystem mutation', async () => {
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'invitation.json');
  try {
    await assert.rejects(
      prepareInvitationArtifact({
        outputPath,
        tokenFactory: () => 'not-a-valid-token',
      }),
      (error) => error?.code === 'TENANT_OPERATOR_INVITATION_TOKEN_INVALID',
    );
    await assert.rejects(stat(outputPath), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

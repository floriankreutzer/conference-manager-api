import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isInternalUuid } from '../src/domain/identifiers.js';
import { normalizeInvitationResult } from '../src/operator/tenant-operator.js';

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const FILE_MODE = 0o600;
const OPEN_FLAGS = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | (constants.O_NOFOLLOW || 0);

export class OperatorInvitationArtifactError extends Error {
  constructor(code = 'TENANT_OPERATOR_INVITATION_ARTIFACT_FAILED') {
    super(code);
    this.name = 'OperatorInvitationArtifactError';
    this.code = code;
  }
}

function artifactError(code) {
  return new OperatorInvitationArtifactError(code);
}

function validateOutputPath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 1_024
    || !isAbsolute(value)
    || CONTROL_CHARACTER.test(value)
  ) {
    throw artifactError('TENANT_OPERATOR_OUTPUT_INVALID');
  }
  return value;
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function removeCreatedFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeExclusive(path, value) {
  let handle = null;
  try {
    handle = await open(path, OPEN_FLAGS, FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(serialized(value), { encoding: 'utf8' });
    await handle.sync();
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original bounded error remains authoritative.
      }
      try {
        await removeCreatedFile(path);
      } catch {
        // Cleanup failure must not expose filesystem details.
      }
    }
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') {
      throw artifactError('TENANT_OPERATOR_OUTPUT_EXISTS');
    }
    throw artifactError('TENANT_OPERATOR_OUTPUT_WRITE_FAILED');
  }
  await handle.close();
}

export async function prepareInvitationArtifact({ outputPath, tokenFactory } = {}) {
  const targetPath = validateOutputPath(outputPath);
  if (typeof tokenFactory !== 'function') {
    throw artifactError('TENANT_OPERATOR_TOKEN_FACTORY_REQUIRED');
  }
  const invitationToken = tokenFactory();
  if (!INVITATION_TOKEN_PATTERN.test(invitationToken || '')) {
    throw artifactError('TENANT_OPERATOR_INVITATION_TOKEN_INVALID');
  }

  await writeExclusive(targetPath, Object.freeze({
    schemaVersion: 1,
    status: 'prepared',
    invitationToken,
  }));

  let finalized = false;
  return Object.freeze({
    invitationToken,

    async finalize({ invitationResult, correlationId } = {}) {
      if (finalized) throw artifactError('TENANT_OPERATOR_INVITATION_ARTIFACT_FINALIZED');
      if (!isInternalUuid(correlationId)) {
        throw artifactError('TENANT_OPERATOR_CORRELATION_INVALID');
      }
      const normalized = normalizeInvitationResult(invitationResult);
      if (normalized.invitationToken !== invitationToken) {
        throw artifactError('TENANT_OPERATOR_INVITATION_TOKEN_MISMATCH');
      }
      const temporaryPath = join(dirname(targetPath), `.tenant-invitation-${randomUUID()}.tmp`);
      try {
        await writeExclusive(temporaryPath, Object.freeze({
          schemaVersion: 1,
          status: 'created',
          tenantId: normalized.tenantId,
          invitationToken,
          expiresAt: normalized.expiresAt,
          correlationId,
        }));
        await rename(temporaryPath, targetPath);
        finalized = true;
      } catch (error) {
        try {
          await removeCreatedFile(temporaryPath);
        } catch {
          // The token-only artifact remains available for controlled recovery.
        }
        if (error instanceof OperatorInvitationArtifactError) throw error;
        throw artifactError('TENANT_OPERATOR_INVITATION_ARTIFACT_FINALIZE_FAILED');
      }
    },

    async abort() {
      if (finalized) return;
      try {
        await removeCreatedFile(targetPath);
      } catch {
        throw artifactError('TENANT_OPERATOR_INVITATION_ARTIFACT_CLEANUP_FAILED');
      }
    },
  });
}

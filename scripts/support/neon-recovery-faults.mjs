import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createNeonBranchStorageConfig } from '../../src/media/neon-storage-config.js';
import { mediaObjectReference, verifyMediaObjectBytes, MediaObjectStorageError } from '../../src/media/object-storage-contract.js';
import { RECOVERY_MANIFEST } from './neon-recovery-config.mjs';

const PROVIDER_DEADLINE_MS = 5000;
const PHASE_MS = 5 * 60_000;
const RESTORATION_RESERVE_MS = 60_000;
const SCENARIO_RESERVE_MS = 90_000;
const FAULT_CODES = Object.freeze({ missing: 'MEDIA_STORAGE_OBJECT_MISSING', corrupt: 'MEDIA_STORAGE_INTEGRITY_FAILED' });

export function recoveryFaultReferences(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== 34) throw new Error('NEON_RECOVERY_FAULT_SCOPE_INVALID');
  const references = inputs.map((input) => {
    const reference = mediaObjectReference(input);
    if (reference.key !== input.key) throw new Error('NEON_RECOVERY_FAULT_SCOPE_INVALID');
    return reference;
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const manifest = references.map(({ key, sha256, byteLength }) => ({ key, sha256, size: byteLength }));
  if (createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !== RECOVERY_MANIFEST) {
    throw new Error('NEON_RECOVERY_FAULT_SCOPE_INVALID');
  }
  return Object.freeze(['room', 'catalogue'].map((kind) => references.filter((reference) => reference.kind === kind)
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.assetId.localeCompare(b.assetId))[0]));
}

async function assertProviderFault(storage, reference, expectedCode) {
  let failure;
  try { verifyMediaObjectBytes(await storage.get(reference), reference); } catch (error) { failure = error; }
  if (!(failure instanceof MediaObjectStorageError) || failure.code !== expectedCode) {
    throw new Error('NEON_RECOVERY_PROVIDER_FAULT_NOT_OBSERVED');
  }
}

// Script-only operator capability. The main-only entrypoint supplies live, checked
// role/child-marker authority; no production adapter or HTTP endpoint imports this.
// Only these two canonical references can be damaged, one at a time, and every
// attempted mutation is followed by verified restoration in finally.
export async function createRecoveryFaultController({
  settings, references, storage, assertAuthority, expiresAt,
}, { clientFactory = (options) => new S3Client(options), now = Date.now } = {}) {
  const targets = recoveryFaultReferences(references);
  const expected = createNeonBranchStorageConfig({ branch: settings?.branch, bucket: 'conference-manager-media',
    accessKeyId: settings?.storage?.accessKeyId, secretAccessKey: settings?.storage?.secretAccessKey });
  if (expected.endpoint !== settings.storage.endpoint || expected.region !== settings.storage.region
    || expected.bucket !== settings.storage.bucket || !storage?.get || !storage?.put || !storage?.remove
    || typeof assertAuthority !== 'function' || !Number.isSafeInteger(expiresAt)) {
    throw new Error('NEON_RECOVERY_FAULT_CONTEXT_INVALID');
  }
  const phaseDeadline = Math.min(now() + PHASE_MS, expiresAt - RESTORATION_RESERVE_MS);
  let closed = false;
  let active = false;
  const attemptedScenarios = new Set();
  function assertActive() {
    if (closed || now() >= phaseDeadline) throw new Error('NEON_RECOVERY_FAULT_PHASE_EXPIRED');
  }
  function assertNewFault() {
    assertActive();
    if (now() + SCENARIO_RESERVE_MS >= phaseDeadline) throw new Error('NEON_RECOVERY_FAULT_RESERVE_REQUIRED');
  }
  async function assertCurrentAuthority() {
    if (now() >= expiresAt || await assertAuthority() !== expiresAt || now() >= expiresAt) {
      throw new Error('NEON_RECOVERY_FAULT_AUTHORITY_INVALID');
    }
  }
  assertNewFault();
  await assertCurrentAuthority();
  assertNewFault();
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  let client;
  try {
    client = clientFactory({ endpoint: expected.endpoint, region: expected.region,
      forcePathStyle: true, followRegionRedirects: false, maxAttempts: 1,
      credentials: { accessKeyId: expected.accessKeyId, secretAccessKey: expected.secretAccessKey },
      requestHandler: { connectionTimeout: 1000, requestTimeout: PROVIDER_DEADLINE_MS,
        throwOnRequestTimeout: true, httpsAgent: agent },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  } catch { agent.destroy(); throw new Error('NEON_RECOVERY_FAULT_CLIENT_FAILED'); }

  async function corrupt(reference, original) {
    const bytes = Buffer.from(original);
    bytes[bytes.length - 1] ^= 1;
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('NEON_RECOVERY_FAULT_PUT_FAILED'));
        }, PROVIDER_DEADLINE_MS);
      });
      // Deliberate corruption cannot use adapter.put: its pre-write SHA check must
      // keep rejecting it. This operator-only command never changes metadata.
      await Promise.race([deadline, client.send(new PutObjectCommand({ Bucket: expected.bucket,
        Key: reference.key, Body: bytes, ContentLength: reference.byteLength, ContentType: reference.contentType,
      }), { abortSignal: controller.signal })]);
    } catch { throw new Error('NEON_RECOVERY_FAULT_PUT_FAILED'); }
    finally { clearTimeout(timer); }
  }

  return Object.freeze({
    targets,
    assertActive,
    phaseDeadline,
    async withFault(input, fault, inspect) {
      const reference = mediaObjectReference(input);
      const target = targets.find(({ key }) => key === reference.key);
      const scenario = `${reference.key}:${fault}`;
      if (!target || JSON.stringify(target) !== JSON.stringify(reference) || !Object.hasOwn(FAULT_CODES, fault)
        || typeof inspect !== 'function' || active || attemptedScenarios.has(scenario)) {
        throw new Error('NEON_RECOVERY_FAULT_SCOPE_INVALID');
      }
      assertNewFault();
      active = true;
      let attempted = false;
      let original;
      try {
        await assertCurrentAuthority();
        original = Buffer.from(verifyMediaObjectBytes(await storage.get(reference), reference));
        await assertCurrentAuthority();
        assertNewFault();
        attempted = true;
        attemptedScenarios.add(scenario);
        if (fault === 'missing') await storage.remove(reference);
        else await corrupt(reference, original);
        assertActive();
        await assertProviderFault(storage, reference, FAULT_CODES[fault]);
        const evidence = await inspect(FAULT_CODES[fault]);
        return Object.freeze({ ...evidence, providerFailureCode: FAULT_CODES[fault], originalRestored: true });
      } finally {
        try {
          if (attempted) {
            await assertCurrentAuthority();
            if (await storage.put(reference, original) !== reference.key) throw new Error('RESTORE_KEY_INVALID');
            verifyMediaObjectBytes(await storage.get(reference), reference);
            if (now() >= expiresAt) throw new Error('RESTORE_COMPLETED_AFTER_EXPIRY');
          }
        } catch { throw new Error('NEON_RECOVERY_RESTORATION_FAILED'); }
        finally { active = false; }
      }
    },
    close() {
      if (active) throw new Error('NEON_RECOVERY_FAULT_ACTIVE');
      if (closed) return;
      closed = true;
      try { client.destroy(); } finally { agent.destroy(); }
    },
  });
}

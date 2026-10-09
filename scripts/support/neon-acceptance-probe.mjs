import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { mediaObjectReference } from '../../src/media/object-storage-contract.js';
import { validateNeonStorageConfig } from '../../src/media/neon-object-storage.js';

export const ACCEPTANCE_BRANCH = 'br-falling-glade-b17oqqiv';
const ENDPOINT = `https://${ACCEPTANCE_BRANCH}.storage.c-5.eu-central-1.aws.neon.tech`;
const BUCKET = 'conference-manager-media';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWOoSAkAAAKEAS30V0rPAAAAAElFTkSuQmCC',
  'base64',
);

export function loadNeonAcceptanceConfig(env) {
  if (env.NODE_ENV !== 'test' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main'
    || env.NEON_ACCEPTANCE_CONFIRM_BRANCH !== ACCEPTANCE_BRANCH || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
    throw new Error('NEON_ACCEPTANCE_CONTEXT_INVALID');
  }
  return validateNeonStorageConfig({ endpoint: ENDPOINT, region: 'eu-central-1', bucket: BUCKET,
    accessKeyId: env.NEON_ACCEPTANCE_ACCESS_KEY_ID, secretAccessKey: env.NEON_ACCEPTANCE_SECRET_ACCESS_KEY });
}

// Only this fixed isolated destination and this invocation's synthetic reference are used.
export function readAnonymousProbe(reference, { requester = request } = {}) {
  const url = new URL(`/${BUCKET}/${mediaObjectReference(reference).key}`, ENDPOINT);
  return new Promise((resolve, reject) => {
    const outgoing = requester(url, { method: 'GET', signal: AbortSignal.timeout(5000), maxHeaderSize: 16384 }, (response) => {
      const status = response.statusCode;
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8192) response.destroy(new Error('NEON_ACCEPTANCE_ANONYMOUS_FAILED'));
      });
      response.resume();
      response.once('end', () => resolve(status));
      response.once('error', () => reject(new Error('NEON_ACCEPTANCE_ANONYMOUS_FAILED')));
    });
    outgoing.once('error', () => reject(new Error('NEON_ACCEPTANCE_ANONYMOUS_FAILED')));
    outgoing.end();
  });
}

export async function runNeonAcceptanceProbe({ storage, anonymousRead = readAnonymousProbe, sourceRuntimeRef, recordIntent = () => {} }) {
  if (!/^[a-f0-9]{40}$/.test(sourceRuntimeRef || '')) throw new Error('NEON_ACCEPTANCE_SOURCE_INVALID');
  const reference = mediaObjectReference({ tenantId: randomUUID(), assetId: randomUUID(), kind: 'catalogue',
    contentType: 'image/png', byteLength: PIXEL.length, sha256: createHash('sha256').update(PIXEL).digest('hex') });
  const evidence = { schemaVersion: 1, scope: 'real-neon-sdk-probe-only', sourceRuntimeRef,
    branch: ACCEPTANCE_BRANCH, bucket: BUCKET, ephemeralObjectKey: reference.key,
    bytes: reference.byteLength, sha256: reference.sha256, putVerified: false, readVerified: false,
    anonymousDenied: false, deleteVerified: false, missingVerified: false, passed: false };
  let intentRecorded = false;
  try {
    await recordIntent(Object.freeze({ ...evidence }));
    intentRecorded = true;
    await storage.put(reference, PIXEL);
    evidence.putVerified = true;
    const bytes = await storage.get(reference);
    if (!Buffer.isBuffer(bytes) || !bytes.equals(PIXEL)) throw new Error('NEON_ACCEPTANCE_BYTES_INVALID');
    evidence.readVerified = true;
    evidence.anonymousDenied = await anonymousRead(reference) === 403;
    if (!evidence.anonymousDenied) throw new Error('NEON_ACCEPTANCE_PRIVACY_FAILED');
  } catch {
    // Provider errors and credential material must never enter logs or artifacts.
  } finally {
    try {
      if (intentRecorded) {
        // Even a failed PUT can have committed remotely. Delete only this invocation's exact key.
        await storage.remove(reference);
        evidence.deleteVerified = true;
        try { await storage.get(reference); }
        catch (error) { evidence.missingVerified = error?.code === 'MEDIA_STORAGE_OBJECT_MISSING'; }
      }
    } catch {
      evidence.deleteVerified = false;
    } finally { storage.close(); }
  }
  evidence.passed = evidence.putVerified && evidence.readVerified && evidence.anonymousDenied
    && evidence.deleteVerified && evidence.missingVerified;
  return Object.freeze(evidence);
}

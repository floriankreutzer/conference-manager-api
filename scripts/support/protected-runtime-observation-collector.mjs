import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { readProtectedFrontendArtifact } from '../../src/protected-frontend-artifact.js';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { normalizeRuntimeObservationPlan, exactObservationObject, PROTECTED_OBSERVATION_ORIGINS,
  OBSERVATION_MAX_AGE_MS, refuseRuntimeObservation } from './protected-runtime-observation-plan.mjs';

const collected = new WeakMap();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function pinnedManifest(file, expectedDigest) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(262145);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead);
    if (bytesRead < 1 || bytesRead > 262144 || digest(raw) !== expectedDigest) refuseRuntimeObservation();
    return JSON.parse(raw.toString('utf8'));
  } finally { await handle.close(); }
}

async function responseBytes(response, maximum, signal) {
  if (!response.body || response.redirected || !response.headers.get('content-type')) refuseRuntimeObservation();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum || signal.aborted) {
      refuseRuntimeObservation();
    }
    chunks.push(chunk);
  }
  if (signal.aborted) refuseRuntimeObservation();
  return Buffer.concat(chunks);
}

async function collectSurface({ surface, plan, root, fetchImpl, signal }) {
  const profile = { surface, environment: 'int', apiCommit: plan.apiCommit, frontendCommit: plan.frontendCommit,
    customerOrigin: PROTECTED_OBSERVATION_ORIGINS.customer, platformOrigin: PROTECTED_OBSERVATION_ORIGINS.platform,
    syntheticEnabled: true, ownerCustomerAccessEnabled: true, hostedFrontendSha256: plan[surface].frontendSha256 };
  const artifact = await readProtectedFrontendArtifact(path.join(root, surface), profile);
  const manifest = await pinnedManifest(path.join(root, surface, 'manifest.json'), plan[surface].frontendSha256);
  const origin = PROTECTED_OBSERVATION_ORIGINS[surface];
  async function get(route, maximum) {
    const url = new URL(route, origin).href;
    if (new URL(url).origin !== origin) refuseRuntimeObservation();
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
      cache: 'no-store', signal, headers: { Accept: '*/*' } });
    if (response.url !== url) refuseRuntimeObservation();
    return { response, bytes: await responseBytes(response, maximum, signal) };
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < manifest.files.length) {
      const file = manifest.files[cursor++];
      const route = file.path === artifact.entry ? (surface === 'customer' ? '/' : '/platform-admin/') : `/${file.path}`;
      const { response, bytes } = await get(route, MAX_RESPONSE_BYTES);
      if (response.status !== 200 || bytes.length !== file.bytes || digest(bytes) !== file.sha256
        || response.headers.get('content-type') !== artifact.get(file.path).type) refuseRuntimeObservation();
    }
  }));
  // Read health after all sealed bytes: an old/cold HTML interstitial or a
  // different process/build cannot become a successful deployment observation.
  const { response, bytes } = await get(surface === 'customer' ? '/api/v1/health/status' : '/api/v1/platform/health/status', 2048);
  if (!response.headers.get('content-type').startsWith('application/json')) refuseRuntimeObservation();
  const health = JSON.parse(bytes.toString('utf8'));
  const service = surface === 'customer' ? health.service : health;
  if (surface === 'customer') {
    exactObservationObject(health, ['status', 'service', 'requestId']);
    exactObservationObject(service, ['version', 'buildId', 'environment']);
    if (!isInternalUuid(health.requestId)) refuseRuntimeObservation();
  } else exactObservationObject(health, ['status', 'serviceVersion', 'buildId', 'environment']);
  const version = surface === 'customer' ? service.version : service.serviceVersion;
  if (!['ready', 'degraded', 'not_ready'].includes(health.status) || service.environment !== 'production'
    || service.buildId !== plan.apiCommit || version !== plan.serviceVersion
    || response.status !== (health.status === 'not_ready' ? 503 : 200)) refuseRuntimeObservation();
  return Object.freeze({ surface, apiVersion: version, apiBuildId: service.buildId,
    frontendBuildId: plan.frontendCommit, frontendSha256: plan[surface].frontendSha256,
    required: health.status === 'not_ready' ? 'not_ready' : 'ready',
    // Public health omits dependency inventory; never turn its empty optional
    // check set into evidence of healthy Microsoft/mail/provider integrations.
    optional: health.status === 'degraded' ? 'degraded' : 'unknown' });
}

export async function collectProtectedRuntimeObservation({ plan: input, artifactRoot, fetchImpl = fetch,
  clock = Date.now, timeoutMs = 90_000 } = {}) {
  const plan = normalizeRuntimeObservationPlan(input);
  if (!path.isAbsolute(artifactRoot ?? '') || typeof fetchImpl !== 'function' || typeof clock !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 90_000) {
    refuseRuntimeObservation();
  }
  const startedAt = clock(), controller = new AbortController();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0
    || ['customer', 'platform'].some(surface => Date.parse(plan[surface].deployedAt) > startedAt)) refuseRuntimeObservation();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const surfaces = await Promise.all(['customer', 'platform'].map(surface => collectSurface({
      surface, plan, root: artifactRoot, fetchImpl, signal: controller.signal })));
    const observedAt = clock();
    if (!Number.isSafeInteger(observedAt) || observedAt < startedAt
      || observedAt - startedAt >= OBSERVATION_MAX_AGE_MS || controller.signal.aborted) refuseRuntimeObservation();
    const receipt = Object.freeze({});
    collected.set(receipt, Object.freeze({ plan, surfaces: Object.freeze(surfaces), observedAt }));
    return receipt;
  } catch {
    controller.abort();refuseRuntimeObservation();
  } finally { clearTimeout(timer); }
}

// Same-process handoff only: serialized/caller-invented observations cannot be
// persisted. The owned CLI constructs the fixed collector, never browser input.
export function readCollectedRuntimeObservation(receipt) {
  const result = collected.get(receipt);
  if (!result) refuseRuntimeObservation();
  return result;
}

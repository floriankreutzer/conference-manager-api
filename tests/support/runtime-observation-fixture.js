import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeProtectedFrontendFixture, frontendArtifactDigest } from './protected-frontend-artifact-fixture.js';
import { PROTECTED_OBSERVATION_ORIGINS, OBSERVATION_FRONTEND_COMMIT }
  from '../../scripts/support/protected-runtime-observation-plan.mjs';

export async function runtimeObservationFixture(t, securityEpoch = randomUUID()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cm-runtime-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = { environment: 'int', securityEpoch, apiCommit: 'a'.repeat(40), frontendCommit: OBSERVATION_FRONTEND_COMMIT,
    serviceVersion: '0.1.0', evidence: { release: 'release:int-fixture', change: 'change:int-fixture', rollback: null, runbook: null } };
  const files = new Map();
  for (const [index, surface] of ['customer', 'platform'].entries()) {
    const profile = { surface, environment: 'int', apiCommit: plan.apiCommit, frontendCommit: plan.frontendCommit,
      customerOrigin: PROTECTED_OBSERVATION_ORIGINS.customer, platformOrigin: PROTECTED_OBSERVATION_ORIGINS.platform,
      syntheticEnabled: true, ownerCustomerAccessEnabled: true };
    await writeProtectedFrontendFixture(path.join(root, surface), profile);
    const manifestPath = path.join(root, surface, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.microsoftEnabled = true;manifest.invitationsEnabled = true;
    const raw = Buffer.from(JSON.stringify(manifest) + '\n');await writeFile(manifestPath, raw);
    plan[surface] = { deploymentReference: `dep-${String(index + 1).repeat(20)}`,
      deployedAt: '2026-10-27T08:00:00.000Z', frontendSha256: frontendArtifactDigest(raw) };
    for (const file of manifest.files) {
      const route = file.path === (surface === 'customer' ? 'index.html' : 'platform-admin/index.html')
        ? (surface === 'customer' ? '/' : '/platform-admin/') : `/${file.path}`;
      files.set(new URL(route, PROTECTED_OBSERVATION_ORIGINS[surface]).href,
        { bytes: await readFile(path.join(root, surface, file.path)), type: file.path.endsWith('.css')
          ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
    }
  }
  let transform = value => value;const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const file = files.get(url);
    const surface = new URL(url).origin === PROTECTED_OBSERVATION_ORIGINS.customer ? 'customer' : 'platform';
    const payload = surface === 'customer' ? { status: 'ready', requestId: randomUUID(),
      service: { version: plan.serviceVersion, buildId: plan.apiCommit, environment: 'production' } }
      : { status: 'ready', serviceVersion: plan.serviceVersion, buildId: plan.apiCommit, environment: 'production' };
    const result = transform({ url, status: 200, bytes: file?.bytes ?? Buffer.from(JSON.stringify(payload)),
      type: file?.type ?? 'application/json; charset=utf-8' });
    const response = new Response(result.bytes, { status: result.status, headers: { 'content-type': result.type } });
    Object.defineProperty(response, 'url', { value: result.url });return response;
  };
  return { root, plan, files, fetchImpl, calls, transform: value => { transform = value; } };
}

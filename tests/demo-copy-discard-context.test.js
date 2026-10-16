import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDemoCopyDiscardContext } from '../scripts/support/demo-copy-discard-context.mjs';

const now = Date.parse('2026-10-16T05:00:00.000Z');
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_REF: 'refs/heads/main',
  GITHUB_ACTOR: 'floriankreutzer', GITHUB_TRIGGERING_ACTOR: 'floriankreutzer',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '1234', GITHUB_SHA: 'a'.repeat(40),
  DEMO_COPY_SOURCE_SHA: 'a'.repeat(40), DEMO_COPY_ACTION: 'preflight', DEMO_COPY_KIND: 'none',
  DEMO_COPY_EXPIRES_AT: '2026-10-16T05:20:00.000Z' };

test('Demo discard workflow context binds exact Main/owner and a frozen bounded expiry', () => {
  assert.equal(loadDemoCopyDiscardContext(env, now).action, 'preflight');
  const discard = { ...env, DEMO_COPY_ACTION: 'discard', DEMO_COPY_KIND: 'room',
    DEMO_COPY_DECISION: 'saas38-pre-pilot-demo-only', DEMO_COPY_MANIFEST_SHA256: 'b'.repeat(64) };
  assert.equal(loadDemoCopyDiscardContext(discard, now).expectedManifestSha256, 'b'.repeat(64));
  for (const change of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_ACTOR: 'someone' }, { GITHUB_TRIGGERING_ACTOR: 'someone' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REPOSITORY: 'foreign/repository' }, { GITHUB_SHA: 'c'.repeat(40) },
    { NODE_OPTIONS: '' }, { RUNNER_DEBUG: '1' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
    assert.throws(() => loadDemoCopyDiscardContext({ ...discard, ...change }, now), /EXECUTION_CONTEXT_INVALID/);
  }
  for (const change of [{ DEMO_COPY_ACTION: 'purge' }, { DEMO_COPY_KIND: 'none' },
    { DEMO_COPY_DECISION: '' }, { DEMO_COPY_MANIFEST_SHA256: '' },
    { DEMO_COPY_EXPIRES_AT: '2026-10-16T05:31:00.000Z' },
    { DEMO_COPY_EXPIRES_AT: '2026-10-16T05:02:00.000Z' },
    { DEMO_COPY_EXPIRES_AT: '2026-02-30T05:20:00.000Z' }]) {
    assert.throws(() => loadDemoCopyDiscardContext({ ...discard, ...change }, now), /OPERATION_INVALID/);
  }
  assert.throws(() => loadDemoCopyDiscardContext({ ...env, DEMO_COPY_MANIFEST_SHA256: 'b'.repeat(64) }, now),
    /OPERATION_INVALID/);
});

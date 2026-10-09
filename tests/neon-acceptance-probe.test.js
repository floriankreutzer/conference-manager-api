import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { ACCEPTANCE_BRANCH, loadNeonAcceptanceConfig, readAnonymousProbe,
  runNeonAcceptanceProbe } from '../scripts/support/neon-acceptance-probe.mjs';

const sourceRuntimeRef = 'a'.repeat(40);
const env = { NODE_ENV: 'test', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceRuntimeRef,
  NEON_ACCEPTANCE_CONFIRM_BRANCH: ACCEPTANCE_BRANCH, NEON_ACCEPTANCE_ACCESS_KEY_ID: 'test-access-key',
  NEON_ACCEPTANCE_SECRET_ACCESS_KEY: 'test-only-secret-material' };

function fixture({ putFails = false, corrupt = false, deleteFails = false, missingCode = 'MEDIA_STORAGE_OBJECT_MISSING' } = {}) {
  const calls = [];
  let stored;
  const storage = {
    async put(reference, bytes) {
      calls.push(['put', reference.key]); stored = Buffer.from(bytes);
      if (putFails) throw new Error(env.NEON_ACCEPTANCE_SECRET_ACCESS_KEY);
    },
    async get(reference) {
      calls.push(['get', reference.key]);
      if (!stored) throw Object.assign(new Error('private-provider-details'), { code: missingCode });
      return corrupt ? Buffer.from('corrupt') : stored;
    },
    async remove(reference) {
      calls.push(['remove', reference.key]);
      if (deleteFails) throw new Error('private-provider-details');
      stored = undefined;
    },
    close() { calls.push(['close']); },
  };
  return { calls, storage };
}

test('manual provider acceptance rejects wrong execution context and cannot target production', () => {
  for (const change of [{ NODE_ENV: 'production' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'invalid' }, { NEON_ACCEPTANCE_CONFIRM_BRANCH: 'br-summer-rice-b1f8voyp' },
    { NEON_ACCEPTANCE_ACCESS_KEY_ID: undefined }, { NEON_ACCEPTANCE_SECRET_ACCESS_KEY: undefined }]) {
    assert.throws(() => loadNeonAcceptanceConfig({ ...env, ...change }));
  }
  const config = loadNeonAcceptanceConfig({ ...env, NEON_ACCEPTANCE_ENDPOINT: 'https://production.invalid' });
  assert.equal(config.endpoint, `https://${ACCEPTANCE_BRANCH}.storage.c-5.eu-central-1.aws.neon.tech`);
  assert.equal(config.bucket, 'conference-manager-media');
});

test('real-provider probe verifies exact bytes, private access and exact-key cleanup before success', async () => {
  const state = fixture();
  const originalPut = state.storage.put;
  state.storage.put = async (reference, bytes) => {
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 1);
    assert.equal(metadata.height, 1);
    await sharp(bytes).raw().toBuffer();
    return originalPut(reference, bytes);
  };
  let intent;
  const result = await runNeonAcceptanceProbe({ ...state, anonymousRead: async () => 403, sourceRuntimeRef,
    recordIntent(value) { assert.equal(state.calls.length, 0); intent = value; } });
  assert.equal(result.passed, true);
  assert.equal(result.scope, 'real-neon-sdk-probe-only');
  assert.deepEqual(state.calls.map(([method]) => method), ['put', 'get', 'remove', 'get', 'close']);
  assert.ok(state.calls.slice(0, 4).every(([, key]) => key === result.ephemeralObjectKey));
  assert.equal(intent.ephemeralObjectKey, result.ephemeralObjectKey);
  assert.equal(intent.passed, false);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret-material|private-provider-details/);
});

test('ambiguous failed upload is cleaned up without reporting a successful provider roundtrip', async () => {
  const state = fixture({ putFails: true });
  const result = await runNeonAcceptanceProbe({ ...state, anonymousRead: async () => 403, sourceRuntimeRef });
  assert.equal(result.passed, false);
  assert.equal(result.deleteVerified, true);
  assert.equal(result.missingVerified, true);
  assert.deepEqual(state.calls.map(([method]) => method), ['put', 'remove', 'get', 'close']);
});

test('corruption, public access, redirect, failed delete and unavailable post-delete read never pass', async () => {
  for (const [options, status] of [[{ corrupt: true }, 403], [{}, 200], [{}, 302], [{ deleteFails: true }, 403],
    [{ missingCode: 'MEDIA_STORAGE_UNAVAILABLE' }, 403]]) {
    const state = fixture(options);
    const result = await runNeonAcceptanceProbe({ ...state, anonymousRead: async () => status, sourceRuntimeRef });
    assert.equal(result.passed, false);
    assert.equal(state.calls.at(-1)[0], 'close');
    assert.equal(state.calls.filter(([method]) => method === 'remove').length, 1);
  }
});

test('each probe owns a unique synthetic object and validates source before I/O', async () => {
  const results = [];
  for (let index = 0; index < 2; index += 1) {
    results.push(await runNeonAcceptanceProbe({ ...fixture(), anonymousRead: async () => 403, sourceRuntimeRef }));
  }
  assert.notEqual(results[0].ephemeralObjectKey, results[1].ephemeralObjectKey);
  const state = fixture();
  await assert.rejects(runNeonAcceptanceProbe({ ...state, sourceRuntimeRef: 'invalid' }));
  assert.equal(state.calls.length, 0);
});

test('manual secret-bearing workflow is main-only, bounded and retains safe evidence on failure', async () => {
  const workflow = await readFile('.github/workflows/neon-object-acceptance.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|push:|continue-on-error|curl|echo.*SECRET|node-version: 'latest'/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /neon-object-acceptance.json/);
  assert.match(workflow, /neon-object-acceptance-intent.json/);
});

test('anonymous verification is unsigned, fixed-destination and bounded, without accepting oversized bodies', async () => {
  const reference = { tenantId: '11111111-1111-4111-8111-111111111111',
    assetId: '22222222-2222-4222-8222-222222222222', kind: 'catalogue', contentType: 'image/png',
    byteLength: 1, sha256: 'b'.repeat(64) };
  for (const size of [8, 8193]) {
    const result = readAnonymousProbe(reference, { requester(url, options, consume) {
      assert.equal(url.hostname, `${ACCEPTANCE_BRANCH}.storage.c-5.eu-central-1.aws.neon.tech`);
      assert.equal(url.username, '');
      assert.equal(url.search, '');
      assert.equal(options.headers, undefined);
      assert.equal(options.method, 'GET');
      assert.ok(options.signal instanceof AbortSignal);
      const outgoing = new EventEmitter();
      outgoing.end = () => {
        const response = Readable.from([Buffer.alloc(size)]);
        response.statusCode = 403;
        consume(response);
      };
      return outgoing;
    } });
    if (size === 8) assert.equal(await result, 403);
    else await assert.rejects(result, /NEON_ACCEPTANCE_ANONYMOUS_FAILED/);
  }
});

test('intent failure prevents upload; CLI without protected context emits only a fixed safe failure', async () => {
  const state = fixture();
  const result = await runNeonAcceptanceProbe({ ...state, sourceRuntimeRef,
    recordIntent() { throw new Error(env.NEON_ACCEPTANCE_SECRET_ACCESS_KEY); } });
  assert.equal(result.passed, false);
  assert.equal(state.calls.filter(([method]) => method === 'put').length, 0);
  assert.deepEqual(state.calls, [['close']]);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret-material/);
  const cli = spawnSync(process.execPath, ['scripts/neon-object-acceptance.mjs'], {
    env: { ...process.env, NODE_ENV: 'production', NEON_ACCEPTANCE_SECRET_ACCESS_KEY: env.NEON_ACCEPTANCE_SECRET_ACCESS_KEY },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(cli.status, 1);
  assert.deepEqual(JSON.parse(cli.stdout), { schemaVersion: 1, passed: false, code: 'NEON_ACCEPTANCE_FAILED' });
  assert.doesNotMatch(cli.stdout + cli.stderr, /test-only-secret-material|private-provider-details/);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const script = path.resolve('scripts/prepare-public-api-publication.mjs');

function artifactDigest(files) {
  const canonical = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${name}\0${content}\0`)
    .join('');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function run(cwd, version = '1.0.0') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, PUBLIC_API_CONTRACT_VERSION: version },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function fixture(overrides = {}, files = { 'openapi.yaml': 'openapi: 3.1.0' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cm-publication-'));
  const source = path.join(root, 'public-api-release');
  await mkdir(source);
  const manifest = {
    approved: true,
    artifactDigest: artifactDigest(files),
    contractVersion: '1.0.0',
    files: Object.keys(files),
    ...overrides,
  };
  await writeFile(path.join(source, 'publication.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(source, name), content);
  }
  return root;
}

test('fails closed when release approval is absent', async () => {
  const root = await fixture({ approved: false });
  const result = await run(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_RELEASE_NOT_APPROVED/);
});

test('rejects files outside the explicit public allowlist', async () => {
  const root = await fixture({}, { 'internal.md': 'private' });
  const result = await run(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_FILE_NOT_ALLOWLISTED/);
});

test('rejects obvious credential material before publication', async () => {
  const root = await fixture(
    {},
    { 'openapi.yaml': 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
  );
  const result = await run(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_SECRET_PATTERN_DETECTED/);
});

test('rejects private OpenAPI destinations before publication', async () => {
  const root = await fixture(
    {},
    { 'openapi.yaml': 'openapi: 3.1.0\nservers:\n  - url: https://api.internal/v1\n' },
  );
  const result = await run(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_PRIVATE_DESTINATION_DETECTED/);
});

test('rejects artifact changes after approval digest is recorded', async () => {
  const root = await fixture(
    { artifactDigest: `sha256:${'a'.repeat(64)}` },
    { 'openapi.yaml': 'openapi: 3.1.0' },
  );
  const result = await run(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_ARTIFACT_DIGEST_MISMATCH/);
});

test('stages only approved files with immutable artifact provenance', async () => {
  const openapi = [
    'openapi: 3.1.0',
    'info:',
    '  title: Synthetic',
    '  version: 1.2.3',
    '',
  ].join('\n');
  const root = await fixture(
    { contractVersion: '1.2.3' },
    { 'openapi.yaml': openapi },
  );
  const result = await run(root, '1.2.3');
  assert.equal(result.code, 0);
  const provenancePath = path.join(root, '.public-api-publication', 'publication.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.equal(provenance.artifactDigest, artifactDigest({ 'openapi.yaml': openapi }));
  assert.deepEqual(provenance.files, ['openapi.yaml']);
});

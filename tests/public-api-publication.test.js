import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const script = path.resolve('scripts/prepare-public-api-publication.mjs');
const sha = 'a'.repeat(40);

function run(cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function fixture(manifest, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cm-publication-'));
  const source = path.join(root, 'public-api-release');
  await mkdir(source);
  await writeFile(path.join(source, 'publication.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(source, name), content);
  }
  return root;
}

function environment(version) {
  return {
    PUBLIC_API_SOURCE_COMMIT: sha,
    PUBLIC_API_CONTRACT_VERSION: version,
  };
}

test('fails closed when release approval is absent', async () => {
  const root = await fixture(
    {
      approved: false,
      sourceCommit: sha,
      contractVersion: '1.0.0',
      files: ['openapi.yaml'],
    },
    { 'openapi.yaml': 'openapi: 3.1.0' },
  );
  const result = await run(root, environment('1.0.0'));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_RELEASE_NOT_APPROVED/);
});

test('rejects files outside the explicit public allowlist', async () => {
  const root = await fixture(
    {
      approved: true,
      sourceCommit: sha,
      contractVersion: '1.0.0',
      files: ['internal.md'],
    },
    { 'internal.md': 'private' },
  );
  const result = await run(root, environment('1.0.0'));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_FILE_NOT_ALLOWLISTED/);
});

test('rejects obvious credential material', async () => {
  const root = await fixture(
    {
      approved: true,
      sourceCommit: sha,
      contractVersion: '1.0.0',
      files: ['openapi.yaml'],
    },
    { 'openapi.yaml': 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
  );
  const result = await run(root, environment('1.0.0'));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PUBLIC_API_SECRET_PATTERN_DETECTED/);
});

test('stages only approved files with immutable provenance', async () => {
  const root = await fixture(
    {
      approved: true,
      sourceCommit: sha,
      contractVersion: '1.2.3',
      files: ['openapi.yaml'],
    },
    {
      'openapi.yaml': [
        'openapi: 3.1.0',
        'info:',
        '  title: Synthetic',
        '  version: 1.2.3',
        '',
      ].join('\n'),
    },
  );
  const result = await run(root, environment('1.2.3'));
  assert.equal(result.code, 0);
  const provenancePath = path.join(root, '.public-api-publication', 'publication.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.equal(provenance.sourceCommit, sha);
  assert.deepEqual(provenance.files, ['openapi.yaml']);
});

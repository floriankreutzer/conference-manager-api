import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const gate = fileURLToPath(new URL('../scripts/check-architecture.mjs', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('runtime dependency approval rejects version drift, ranges, missing and extra adapters', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-dependency-approval-'));
  try {
    const missing = { ...manifest.dependencies };
    delete missing['@azure/msal-node'];
    const missingPasskey = { ...manifest.dependencies };
    delete missingPasskey['@simplewebauthn/server'];
    for (const dependencies of [
      { ...manifest.dependencies, '@azure/msal-node': '7.0.1' },
      { ...manifest.dependencies, '@aws-sdk/client-s3': '3.1148.0' },
      { ...manifest.dependencies, '@azure/msal-node': '^7.1.0' },
      { ...manifest.dependencies, '@simplewebauthn/server': '14.0.2' },
      { ...manifest.dependencies, '@simplewebauthn/server': '^14.0.3' },
      { ...manifest.dependencies, unreviewed: '1.0.0' },
      missing,
      missingPasskey,
    ]) {
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies }));
      const result = spawnSync(process.execPath, [gate], {
        cwd: directory, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Runtime dependencies must remain exactly the reviewed/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/check-style.mjs', import.meta.url));

test('style gate accepts LF/CRLF without accepting trailing spaces, tabs, missing newline or excess width', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cm-style-policy-'));
  try {
    for (const root of ['src', 'scripts', 'tests', 'tests-db']) mkdirSync(join(directory, root));
    for (const newline of ['\n', '\r\n']) {
      for (const [source, expectedStatus] of [
        [`export const ready = true;${newline}`, 0],
        [`export const ready = true; ${newline}`, 1],
        [`\texport const ready = true;${newline}`, 1],
        ['export const ready = true;', 1],
        [`//${'x'.repeat(139)}${newline}`, 1],
      ]) {
        writeFileSync(join(directory, 'src', 'probe.js'), source);
        const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

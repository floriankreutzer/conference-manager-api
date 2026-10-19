import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const binary = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));
function lint(code) {
  const directory = mkdtempSync(fileURLToPath(new URL('./lint-probe-', import.meta.url)));
  const target = join(directory, 'probe.js');
  try {
    writeFileSync(target, code + '\n');
    const result = spawnSync(process.execPath, [binary, 'lint', '--config-path=biome.json',
      '--error-on-warnings', target], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(target, 'utf8'), code + '\n');
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('lint gate rejects duplicate keys, undefined authority and unreachable code', () => {
  for (const [code, rule] of [
    ['export const value = { scope: 1, scope: 2 };', 'noDuplicateObjectKeys'],
    ['export const value = unknownAuthority;', 'noUndeclaredVariables'],
    ['export function run() { return; throw new Error(); }', 'noUnreachable'],
  ]) {
    const result = lint(code);
    assert.notEqual(result.status, 0);
    assert.ok(result.output.includes(rule));
  }
});

test('valid native ESM code passes without a formatter, generated fix or source rewrite', () => {
  const result = lint('export const data = Object.freeze({ ready: true });');
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes('No fixes applied'));
});

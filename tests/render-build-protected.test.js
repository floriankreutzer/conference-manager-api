import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProtectedRender } from '../scripts/render-build-protected.mjs';

const env = {
  PROTECTED_API_COMMIT: 'a'.repeat(40), PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),
  PROTECTED_ENVIRONMENT: 'int', PROTECTED_CUSTOMER_ORIGIN: 'https://customer.example',
  PROTECTED_PLATFORM_ORIGIN: 'https://platform.example', PROTECTED_SYNTHETIC_ENABLED: 'true',
  PROTECTED_PRESENTATION_MICROSOFT_ENABLED: 'false', PROTECTED_PRESENTATION_INVITATIONS_ENABLED: 'false',
  PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED: 'false', PRIVATE_RUNTIME_VALUE: 'must-not-reach-builder',
};
const evidence = { apiCommit: env.PROTECTED_API_COMMIT, frontendCommit: env.PROTECTED_FRONTEND_COMMIT,
  manifestSha256: { customer: 'c'.repeat(64), platform: 'd'.repeat(64) } };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protected-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runner(calls, { apiCommit = env.PROTECTED_API_COMMIT, frontendCommit = env.PROTECTED_FRONTEND_COMMIT,
  dirty = '', summary = evidence } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git' && args[0] === 'status') return dirty;
    if (command === 'git' && args.includes('rev-parse')) return args[0] === '-C' ? frontendCommit : apiCommit;
    if (command === process.execPath) return JSON.stringify(summary);
    return '';
  };
}

test('repeated cached builds clean only fixed directories and isolate builder environment', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'keep.txt'), 'preserved');
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const name of ['.protected-ui-build', '.protected-frontend']) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, 'stale'), 'cached');
    }
    const calls = [];
    assert.deepEqual(await buildProtectedRender({ apiRoot: root, env, run: runner(calls) }), evidence);
    for (const name of ['.protected-ui-build', '.protected-frontend']) {
      await assert.rejects(readFile(path.join(root, name, 'stale')), { code: 'ENOENT' });
    }
    assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'preserved');
    const npm = calls.filter(call => call.command === 'npm');
    assert.equal(npm.length, 2);
    for (const call of npm) assert.ok(call.args.includes('--ignore-scripts'));
    const builder = calls.at(-1);
    assert.equal(builder.options.env.PRIVATE_RUNTIME_VALUE, undefined);
    assert.equal(builder.options.env.HOME, undefined);
    assert.equal(builder.options.env.PROTECTED_API_COMMIT, env.PROTECTED_API_COMMIT);
    assert.equal(builder.args[1], path.join(root, '.protected-frontend'));
  }
});

test('invalid authority and dirty or mismatched API source fail before cache deletion', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.protected-ui-build'));
  const marker = path.join(root, '.protected-ui-build', 'stale');
  await writeFile(marker, 'preserved');
  for (const overrides of [
    { PROTECTED_API_COMMIT: 'main' }, { PROTECTED_ENVIRONMENT: 'prod' },
    { PROTECTED_CUSTOMER_ORIGIN: 'https://user:password@example.com' },
    { PROTECTED_SYNTHETIC_ENABLED: undefined },
    { PROTECTED_PLATFORM_ORIGIN: env.PROTECTED_CUSTOMER_ORIGIN },
  ]) {
    const calls = [];
    await assert.rejects(buildProtectedRender({ apiRoot: root, env: { ...env, ...overrides }, run: runner(calls) }));
    assert.equal(calls.length, 0);
  }
  for (const failure of [{ apiCommit: 'e'.repeat(40) }, { dirty: ' M tracked.js' }]) {
    await assert.rejects(buildProtectedRender({ apiRoot: root, env, run: runner([], failure) }));
  }
  assert.equal(await readFile(marker, 'utf8'), 'preserved');
});

test('cache symlinks cannot delete foreign files', async t => {
  for (const name of ['.protected-ui-build', '.protected-frontend']) {
    const root = await fixture(t);
    const outside = await fixture(t);
    await writeFile(path.join(outside, 'keep'), 'preserved');
    await symlink(outside, path.join(root, name));
    await assert.rejects(buildProtectedRender({ apiRoot: root, env, run: runner([]) }));
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'preserved');
  }
});

test('wrong frontend source cannot install dependencies or execute its builder', async t => {
  const calls = [];
  await assert.rejects(buildProtectedRender({ apiRoot: await fixture(t), env,
    run: runner(calls, { frontendCommit: 'e'.repeat(40) }) }));
  assert.ok(calls.every(call => call.command === 'git'));
});

test('unbound or malformed digest summaries cannot be accepted as evidence', async t => {
  for (const summary of [{ ...evidence, apiCommit: 'e'.repeat(40) }, { ...evidence, manifestSha256: {} }]) {
    await assert.rejects(buildProtectedRender({ apiRoot: await fixture(t), env, run: runner([], { summary }) }));
  }
});

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
  await mkdir(path.join(root, 'vendor/protected-frontend'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runner(calls, { apiCommit = env.PROTECTED_API_COMMIT, frontendCommit = env.PROTECTED_FRONTEND_COMMIT,
  dirty = '', frontendDirty = '', gitlink = `160000 commit ${env.PROTECTED_FRONTEND_COMMIT}\tvendor/protected-frontend`,
  checkoutRoot, summary = evidence } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git' && args[0] === 'status') return dirty;
    if (command === 'git' && args[0] === 'ls-tree') return gitlink;
    if (command === 'git' && args.includes('--show-toplevel')) return checkoutRoot ?? args[1];
    if (command === 'git' && args.includes('status')) return frontendDirty;
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
    assert.equal(npm[1].options.cwd, path.join(root, 'vendor/protected-frontend'));
    assert.ok(calls.every(call => !call.args.some(arg => ['clone', 'fetch', 'checkout'].includes(arg))));
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
  for (const failure of [
    { frontendCommit: 'e'.repeat(40) }, { frontendDirty: ' M script.mjs' },
    { gitlink: `160000 commit ${'e'.repeat(40)}\tvendor/protected-frontend` },
    { gitlink: `040000 tree ${env.PROTECTED_FRONTEND_COMMIT}\tvendor/protected-frontend` },
    { checkoutRoot: '/uninitialized-parent' },
  ]) {
    const calls = [];
    await assert.rejects(buildProtectedRender({ apiRoot: await fixture(t), env, run: runner(calls, failure) }));
    assert.ok(calls.every(call => call.command === 'git'));
  }
});

test('missing or symlinked provider checkout fails before installation and cache deletion', async t => {
  for (const link of [false, true]) {
    const root = await fixture(t);
    const source = path.join(root, 'vendor/protected-frontend');
    await rm(source, { recursive: true });
    if (link) await symlink(await fixture(t), source);
    await mkdir(path.join(root, '.protected-ui-build'));
    const marker = path.join(root, '.protected-ui-build', 'stale');
    await writeFile(marker, 'preserved');
    const calls = [];
    await assert.rejects(buildProtectedRender({ apiRoot: root, env, run: runner(calls) }));
    assert.ok(calls.every(call => call.command === 'git'));
    assert.equal(await readFile(marker, 'utf8'), 'preserved');
  }
});

test('unbound or malformed digest summaries cannot be accepted as evidence', async t => {
  for (const summary of [{ ...evidence, apiCommit: 'e'.repeat(40) }, { ...evidence, manifestSha256: {} }]) {
    await assert.rejects(buildProtectedRender({ apiRoot: await fixture(t), env, run: runner([], { summary }) }));
  }
});

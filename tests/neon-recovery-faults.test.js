import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';
import { createRecoveryFaultController, recoveryFaultReferences } from '../scripts/support/neon-recovery-faults.mjs';
import { recoveryHttpTenants } from '../scripts/support/neon-recovery-scenarios.mjs';
import { verifyMediaObjectBytes } from '../src/media/object-storage-contract.js';
import { recoveryReferences, recoverySettings, recoveryBytes, recoveryProviderFixture } from './support/neon-recovery-fixture.js';

const started = 1_000_000;
const expiresAt = started + 60 * 60_000;

function controller(provider, changes = {}, dependencies = {}) {
  return createRecoveryFaultController({ settings: recoverySettings, references: recoveryReferences,
    storage: provider.storage, expiresAt, assertAuthority: async () => expiresAt, ...changes },
  { clientFactory: provider.clientFactory, now: () => started, ...dependencies });
}

test('fault capability validates exact canonical manifest, child endpoint and current authority before SDK allocation', async () => {
  const provider = recoveryProviderFixture();
  try {
    const before = provider.clients.length;
    for (const references of [[], recoveryReferences.slice(1), [...recoveryReferences.slice(1), recoveryReferences[1]]]) {
      await assert.rejects(controller(provider, { references }), /NEON_RECOVERY_FAULT_SCOPE_INVALID/);
    }
    await assert.rejects(controller(provider, { settings: { ...recoverySettings,
      storage: { ...recoverySettings.storage, endpoint: 'https://br-other.storage.c-5.eu-central-1.aws.neon.tech' } } }),
    /NEON_RECOVERY_FAULT_CONTEXT_INVALID/);
    await assert.rejects(controller(provider, { assertAuthority: async () => expiresAt + 1 }),
      /NEON_RECOVERY_FAULT_AUTHORITY_INVALID/);
    await assert.rejects(controller(provider, { assertAuthority: async () => { throw new Error('WRONG_LIVE_ROLE'); } }),
      /WRONG_LIVE_ROLE/);
    assert.equal(provider.clients.length, before);
    assert.deepEqual(provider.commands, []);
  } finally { provider.storage.close(); }
});

test('real unchanged adapter observes controlled missing/corrupt SDK bytes and every finally restores their exact hash', async () => {
  const provider = recoveryProviderFixture();
  const fault = await controller(provider);
  try {
    assert.deepEqual(fault.targets.map(({ kind }) => kind), ['room', 'catalogue']);
    for (const reference of fault.targets) {
      for (const kind of ['missing', 'corrupt']) {
        const result = await fault.withFault(reference, kind, async (code) => {
          await assert.rejects(provider.storage.get(reference), { code });
          if (kind === 'corrupt') {
            assert.equal(provider.objects.get(reference.key).bytes.length, reference.byteLength);
            assert.notDeepEqual(provider.objects.get(reference.key).bytes, recoveryBytes(reference));
          }
          return { inspected: true };
        });
        assert.equal(result.originalRestored, true);
        verifyMediaObjectBytes(await provider.storage.get(reference), reference);
        assert.deepEqual(provider.objects.get(reference.key).bytes, recoveryBytes(reference));
      }
    }
    assert.equal(provider.objects.size, 34);
    const options = provider.clients[1].options;
    assert.equal(options.endpoint, recoverySettings.storage.endpoint);
    assert.equal(options.forcePathStyle, true);
    assert.equal(options.followRegionRedirects, false);
    assert.equal(options.maxAttempts, 1);
    assert.equal(options.requestHandler.httpsAgent.options.maxTotalSockets, 1);
  } finally { fault.close(); provider.storage.close(); }
  assert.equal(provider.clients.every(({ destroyed }) => destroyed), true);
});

test('unknown assets, changed metadata and exhausted phase reserve cannot begin a fault', async () => {
  const provider = recoveryProviderFixture();
  let clock = started;
  const fault = await controller(provider, {}, { now: () => clock });
  try {
    const target = fault.targets[0];
    const other = recoveryReferences.find(({ key }) => !fault.targets.some((reference) => reference.key === key));
    for (const reference of [other, { ...target, byteLength: target.byteLength + 1 }]) {
      await assert.rejects(fault.withFault(reference, 'missing', async () => ({})), /NEON_RECOVERY_FAULT_SCOPE_INVALID/);
    }
    await assert.rejects(fault.withFault(target, 'unknown', async () => ({})), /NEON_RECOVERY_FAULT_SCOPE_INVALID/);
    clock = fault.phaseDeadline - 89_000;
    await assert.rejects(fault.withFault(target, 'missing', async () => ({})), /NEON_RECOVERY_FAULT_RESERVE_REQUIRED/);
    assert.deepEqual(provider.commands, []);
  } finally { fault.close(); provider.storage.close(); }
});

test('a failed inspection restores originals but a failed restoration can never return successful evidence', async () => {
  const provider = recoveryProviderFixture();
  const fault = await controller(provider);
  const target = fault.targets[0];
  try {
    await assert.rejects(fault.withFault(target, 'missing', async () => { throw new Error('HTTP_ASSERTION_FAILED'); }),
      /HTTP_ASSERTION_FAILED/);
    assert.deepEqual(await provider.storage.get(target), recoveryBytes(target));
    provider.rejectPuts(() => true);
    await assert.rejects(fault.withFault(target, 'corrupt', async () => ({ passed: true })),
      { message: 'NEON_RECOVERY_RESTORATION_FAILED' });
  } finally { fault.close(); provider.storage.close(); }
});

test('expired marker prevents later faults and unresolved restoration fails rather than renewing the window', async () => {
  const provider = recoveryProviderFixture();
  let clock = started;
  const fault = await controller(provider, {}, { now: () => clock });
  const target = fault.targets[0];
  try {
    await assert.rejects(fault.withFault(target, 'missing', async () => {
      clock = expiresAt;
      return {};
    }), /NEON_RECOVERY_RESTORATION_FAILED/);
    assert.equal(provider.commands.some(({ name }) => name === 'PutObjectCommand'), false);
    await assert.rejects(fault.withFault(target, 'corrupt', async () => ({})), /NEON_RECOVERY_FAULT_PHASE_EXPIRED/);
  } finally { fault.close(); provider.storage.close(); }
});

test('script fault capability cannot be imported by normal Customer, Platform or Demo runtime entrypoints', () => {
  for (const file of ['src/index.js', 'src/platform-main.js', 'src/customer-composition.js',
    'src/demo/customer-main.js', 'src/demo/platform-main.js', 'src/demo/customer-composition.js', 'src/demo/platform-composition.js']) {
    const prefix = file.startsWith('src/demo/') ? '../../' : '../';
    for (const source of [`import '${prefix}scripts/support/neon-recovery-faults.mjs';`,
      `await import('${prefix}scripts/support/neon-recovery-faults.mjs');`]) {
      assert.ok(moduleBoundaryViolations({ [file]: source })
        .some((message) => message.includes('neon-recovery-faults.mjs cannot be resolved')));
    }
  }
});

test('required fault/history phase precedes all unchanged browser contracts and its report is retained', async () => {
  const workflow = await readFile('.github/workflows/neon-recovery-acceptance.yml', 'utf8');
  const phase = workflow.indexOf('neon-recovery-acceptance.mjs faults');
  assert.ok(phase > workflow.indexOf('neon-recovery-acceptance.mjs preflight'));
  assert.ok(phase < workflow.indexOf('npm run test:e2e:shared-demo'));
  assert.equal(workflow.match(/npm run test:e2e:shared-demo/g).length, 2);
  assert.equal(workflow.match(/npm run test:e2e:saas37/g).length, 2);
  assert.match(workflow, /api\/neon-recovery-faults.json/);
  assert.equal(recoveryFaultReferences(recoveryReferences).length, 2);
});

test('orchestration selects canonical Northwind/Contoso lifecycle personas and rejects a foreign Catalogue owner', () => {
  const targets = recoveryFaultReferences(recoveryReferences);
  assert.deepEqual(recoveryHttpTenants(targets), {
    ownerTenantId: '10000000-0000-4000-8000-000000000001', foreignTenantId: '20000000-0000-4000-8000-000000000002',
  });
  assert.throws(() => recoveryHttpTenants([targets[0], { ...targets[1], tenantId: '20000000-0000-4000-8000-000000000002' }]),
    /NEON_RECOVERY_TENANT_FIXTURE_INVALID/);
  assert.throws(() => recoveryHttpTenants([...targets].reverse()), /NEON_RECOVERY_TENANT_FIXTURE_INVALID/);
  assert.throws(() => recoveryHttpTenants(targets.map((reference) => ({ ...reference,
    tenantId: '40000000-0000-4000-8000-000000000004' }))), /NEON_RECOVERY_TENANT_FIXTURE_INVALID/);
});

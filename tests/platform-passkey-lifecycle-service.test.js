import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformPasskeyLifecycleService } from '../src/platform/identity/passkey-lifecycle-service.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const roles = ['platform_security_admin'];
const now = new Date().toISOString();
const principal = { operatorId: ID, securityVersion: 4,
  providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: ID, subjectReference: OTHER },
  roles, permissions: permissionsForPlatformRoles(roles), targetScope: { mode: 'all', securityVersion: 4 },
  assurance: { level: 'mfa', authenticationContext: 'cm:pk:v1', authenticatedAt: now },
  session: { id: OTHER, securityVersion: 4, securityEpoch: 8, issuedAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(), stepUpExpiresAt: null } };
const credential = Buffer.alloc(32, 1).toString('base64url');

function fixture() {
  let expectedHash; let current = principal; let denied = false;
  const calls = { starts: [], issue: [], revoke: [], modes: [], resolve: 0 };
  async function execute(input, mutation, mode) {
    assert.equal(input.operationHash, expectedHash);
    calls.modes.push(mode);
    const strong = { ...principal, assurance: { ...principal.assurance, level: 'step_up' } };
    return mutation({ principal: strong, operationHash: expectedHash });
  }
  const service = createPlatformPasskeyLifecycleService({ environment: 'int', securityEpoch: 8, idFactory: () => OTHER,
    sessionService: { async resolvePrincipal() { calls.resolve++; return current; } },
    authService: {
      async startStepUp(value, context) { expectedHash = context.operationHash; calls.starts.push({ value, ...context }); return context; },
      async executeStepUp(input, mutation) { return execute(input, mutation, 'rotate'); },
      async executeCredentialLifecycle(input, mutation) { return execute(input, mutation, 'logout'); },
    }, repository: {
      async issueAdditional(value) { calls.issue.push(value); return denied ? null : { grant: { grantId: ID, token: 'opaque' } }; },
      async revokeCredential(value) { calls.revoke.push(value); return denied ? null : { status: 'credential_revoked' }; },
    } });
  return { service, calls, setCurrent: value => { current = value; }, deny: () => { denied = true; } };
}
const request = () => ({ cookie: 'browser-cookie', state: 'browser-state', response: {}, request: {} });

test('addition and revocation bind different server-computed operations, owner/version and exact key', async () => {
  const f = fixture();
  const add = await f.service.startAddition(principal);
  assert.equal((await f.service.issueAdditional(request())).grant.grantId, ID);
  assert.equal(f.calls.issue[0].principal.assurance.level, 'step_up');
  assert.equal(f.calls.issue[0].principal.operatorId, ID);
  assert.equal(f.calls.issue[0].environment, 'int');
  const revoke = await f.service.startRevocation(principal, credential);
  assert.notEqual(add.operationHash, revoke.operationHash);
  await assert.rejects(f.service.revoke({ ...request(), credentialId: Buffer.alloc(32, 2).toString('base64url') }));
  assert.equal(f.calls.revoke.length, 0);
  assert.equal((await f.service.revoke({ ...request(), credentialId: credential })).status, 'credential_revoked');
  assert.deepEqual(f.calls.modes, ['rotate', 'logout']);
  assert.equal(f.calls.revoke[0].credentialId, credential);
});

test('browser-selected operation/owner/approval and stale sessions cannot issue an enrollment grant', async () => {
  const f = fixture(); await f.service.startAddition(principal);
  for (const change of [{ operatorId: OTHER }, { operationHash: 'a'.repeat(64) }, { approved: true }, { approvalReference: 'BROWSER' }]) {
    await assert.rejects(f.service.issueAdditional({ ...request(), ...change }), /LIFECYCLE_REJECTED/);
  }
  assert.equal(f.calls.resolve, 0);
  f.setCurrent({ ...principal, operatorId: OTHER });
  await assert.rejects(f.service.issueAdditional(request()));
  assert.equal(f.calls.issue.length, 0);
  await assert.rejects(f.service.startAddition({ ...principal, session: { ...principal.session, securityEpoch: 9 } }), /REJECTED/);
  await assert.rejects(f.service.startRevocation(principal, 'not=canonical'), /REJECTED/);
});

test('repository denial never becomes an operation result and remains inside the atomic verifier callback', async () => {
  const f = fixture(); f.deny();
  await f.service.startAddition(principal);
  await assert.rejects(f.service.issueAdditional(request()), /LIFECYCLE_REJECTED/);
  await f.service.startRevocation(principal, credential);
  await assert.rejects(f.service.revoke({ ...request(), credentialId: credential }), /LIFECYCLE_REJECTED/);
});

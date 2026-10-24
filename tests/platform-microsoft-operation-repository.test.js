import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPlatformMicrosoftOperationRepository }
  from '../src/persistence/postgres/platform-microsoft-operation-repository.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const id=n=>`d2000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding={ environment: 'int',protectedSecurityEpoch: id(1),securityEpoch: 7,stateHash: 'a'.repeat(64),browserHash: 'b'.repeat(64) };
const roles=['platform_security_admin','platform_tenant_operator'];
const principal={ operatorId: id(2),providerIdentity: { provider: 'microsoft_entra_platform',
  tenantReference: id(3),subjectReference: id(4) },roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 1,
  targetScope: { mode: 'all',securityVersion: 1 },assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',
    authenticatedAt: '2026-10-24T12:00:00.000Z' },session: { id: id(5),securityVersion: 1,securityEpoch: 7,
    issuedAt: '2026-10-24T12:00:00.000Z',expiresAt: '2026-10-24T13:00:00.000Z',stepUpExpiresAt: null } };
function fixture(patch={}) {
  let resources=0;
  const pool={ async query() { resources++;throw new Error('private-driver-detail'); },
    async connect() { resources++;throw new Error('private-driver-detail'); } };
  const config={ ...binding,executionScope: 'shared',scopes: { withShared: work=>work(),withSyntheticExclusive: (_scope,work)=>work() },
    auditRepository: { async appendWithClient() {} },...patch };
  return { pool,config,repository: ()=>createPostgresPlatformMicrosoftOperationRepository(pool,config),count: ()=>resources };
}
test('Microsoft proof repository refuses unknown execution classes and malformed fixed deployment configuration',()=>{
  for (const patch of [{ executionScope: 'caller-selected' },{ environment: 'prod',executionScope: 'synthetic' },
    { protectedSecurityEpoch: 'private-epoch' },{ securityEpoch: 0 },{ scopes: {} },{ auditRepository: null }]) {
    const f=fixture(patch);assert.throws(f.repository,{ message: 'PLATFORM_MICROSOFT_PROOF_REPOSITORY_INVALID' });
    assert.equal(f.count(),0);
  }
});
test('foreign scope, unexpected authority fields and accessors fail before acquiring database resources',async()=>{
  const f=fixture(),repository=f.repository();let accessed=false;
  for (const value of [{ ...binding,environment: 'dev' },{ ...binding,protectedSecurityEpoch: id(9) },
    { ...binding,securityEpoch: 8 },{ ...binding,stateHash: 'private' },{ ...binding,operationHash: 'c'.repeat(64) },
    { ...binding,get stateHash() { accessed=true;return 'a'.repeat(64); } }]) {
    await assert.rejects(repository.findPending(value),{ message: 'PLATFORM_MICROSOFT_PROOF_REPOSITORY_INVALID' });
  }
  await assert.rejects(repository.verify({ ...binding,id: id(6),identity: { provider: 'microsoft_entra_platform',
    tenantReference: id(3),subjectReference: id(4),roles: ['platform_security_admin'],
    assurance: { level: 'step_up',authenticationContext: 'cm:ms:fresh:v1',authenticatedAt: '2026-10-24T12:00:00.000Z' } } }),
  { message: 'PLATFORM_MICROSOFT_PROOF_REPOSITORY_INVALID' });
  assert.equal(accessed,false);assert.equal(f.count(),0);
});
test('a caller-supplied shared callback cannot manufacture the private live execution marker',async()=>{
  const f=fixture(),repository=f.repository();
  await assert.rejects(repository.findPending(binding),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  await assert.rejects(repository.create({ ...binding,id: id(6),nonceHash: 'c'.repeat(64),operationHash: 'd'.repeat(64),
    correlationId: id(7),expectedPrincipal: principal,ttlSeconds: 120 }),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  await assert.rejects(repository.authenticate({ ...binding,id: id(6),operationHash: 'd'.repeat(64),expectedPrincipal: principal },
    ()=>{ throw new Error('must not mutate'); }),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  assert.equal(f.count(),0);
});

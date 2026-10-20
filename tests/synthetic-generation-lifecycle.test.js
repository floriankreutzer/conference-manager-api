import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { normalizeSyntheticGenerationIntent,syntheticGenerationOperationHash,requireOwnedSyntheticTenantArchival,
  SYNTHETIC_GENERATION_RETENTION_LIMIT,SYNTHETIC_GENERATION_COOLDOWN_MS } from '../src/domain/synthetic-generation-lifecycle.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy,permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';
import { requireTenantLifecycleTransition } from '../src/tenancy/tenant-lifecycle-policy.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';

const operatorId=randomUUID(),generationId=randomUUID(),epoch=randomUUID(),correlationId=randomUUID();
const scope={ environment: 'int',securityEpoch: epoch },intent={ operatorId,expectedGenerationId: null,expectedRevision: 0 };
const NOW=Date.parse('2026-10-20T18:00:00.000Z');
function principal(patch={}) {
  const roles=['platform_tenant_operator'];
  return { operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
    providerIdentity: { provider: PLATFORM_ENTRA_PROVIDER,tenantReference: 'directory',subjectReference: 'owner' },
    targetScope: { mode: 'allowlist',securityVersion: 3 },assurance: { level: 'step_up',authenticationContext: 'cm:pk:v1',
      authenticatedAt: new Date(NOW).toISOString() },session: { id: randomUUID(),securityEpoch: 7,securityVersion: 3,
      issuedAt: new Date(NOW).toISOString(),expiresAt: new Date(NOW+3_600_000).toISOString(),
      stepUpExpiresAt: new Date(NOW+300_000).toISOString() },...patch };
}
function fixture(identity=principal()) {
  const context=Object.freeze({}),expected=syntheticGenerationOperationHash(scope,intent),calls=[];
  let consumed=false;
  const service=createSyntheticGenerationService({ ...scope,authorizationPolicy: createPlatformAuthorizationPolicy({ clock: ()=>NOW }),
    passkeyService: { verifiedOperationPrincipal(value,hash) {
      if (value!==context || hash!==expected || consumed) throw new Error('EXACT_PROOF_DENIED');
      consumed=true;return identity;
    } },repository: { async replace(input) { calls.push(input);return { generationId }; } } });
  return { service,context,calls };
}

test('generation intent is canonical, bounded and proof-bound to environment, epoch, owner and expected generation/revision',()=>{
  const hash=syntheticGenerationOperationHash(scope,intent);assert.match(hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(normalizeSyntheticGenerationIntent({ ...intent,operatorId: operatorId.toUpperCase() }),intent);
  for (const patch of [{ environment: 'dev' },{ securityEpoch: randomUUID() }]) {
    assert.notEqual(syntheticGenerationOperationHash({ ...scope,...patch },intent),hash);
  }
  for (const patch of [{ operatorId: randomUUID() },{ expectedGenerationId: generationId,expectedRevision: 1 }]) {
    assert.notEqual(syntheticGenerationOperationHash(scope,{ ...intent,...patch }),hash);
  }
  for (const patch of [{ operatorId: null },{ expectedRevision: 1 },{ expectedRevision: -1 },
    { expectedGenerationId: generationId },{ roles: ['platform_tenant_operator'] },{ tenantId: randomUUID() }]) {
    assert.throws(()=>normalizeSyntheticGenerationIntent({ ...intent,...patch }),/INTENT_INVALID/);
  }
  assert.throws(()=>syntheticGenerationOperationHash({ ...scope,environment: 'prod' },intent),/INTENT_INVALID/);
  assert.equal(SYNTHETIC_GENERATION_RETENTION_LIMIT,32);assert.equal(SYNTHETIC_GENERATION_COOLDOWN_MS,10_000);
});

test('exact proof and canonical permission reach the own generation transaction without expanding an allowlist',async()=>{
  const f=fixture();assert.equal(f.service.operationHash(intent),syntheticGenerationOperationHash(scope,intent));
  assert.deepEqual(await f.service.replace({ proofContext: f.context,intent,correlationId }),{ generationId });
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].principal.targetScope.mode,'allowlist');
  await assert.rejects(f.service.replace({ proofContext: f.context,intent,correlationId }),/EXACT_PROOF_DENIED/);
  for (const proofContext of [undefined,{},principal()]) {
    const candidate=fixture();await assert.rejects(candidate.service.replace({ proofContext,intent,correlationId }),/EXACT_PROOF_DENIED/);
    assert.equal(candidate.calls.length,0);
  }
  const stale=fixture();
  await assert.rejects(stale.service.replace({ proofContext: stale.context,
    intent: { ...intent,expectedGenerationId: generationId,expectedRevision: 1 },correlationId }),/EXACT_PROOF_DENIED/);
  assert.equal(stale.calls.length,0);
});

test('Customer provider, foreign owner, non-passkey assurance, expired proof and read-only roles cannot replace generations',async()=>{
  const base=principal();
  for (const patch of [{ operatorId: randomUUID() },{ providerIdentity: { ...base.providerIdentity,provider: 'microsoft_entra' } },
    { assurance: { ...base.assurance,authenticationContext: 'other' } },
    { session: { ...base.session,stepUpExpiresAt: new Date(NOW-1).toISOString(),issuedAt: new Date(NOW-1000).toISOString() },
      assurance: { ...base.assurance,authenticatedAt: new Date(NOW-1000).toISOString() } },
    { roles: ['platform_support_reader'],permissions: permissionsForPlatformRoles(['platform_support_reader']) }]) {
    const f=fixture({ ...base,...patch });await assert.rejects(f.service.replace({ proofContext: f.context,intent,correlationId }));
    assert.equal(f.calls.length,0);
  }
  const f=fixture();await assert.rejects(f.service.replace({ proofContext: f.context,intent,correlationId,tenantId: randomUUID() }),
    /INPUT_INVALID/);assert.equal(f.calls.length,0);
});

test('synthetic archival permits the onboarding scenario only inside its exact immutable own generation',()=>{
  const owned={ environment: 'int',operatorId,generationId };
  const tenant={ ...owned,mode: 'synthetic',tenantId: randomUUID(),slot: 'fabrikam',status: 'onboarding',revision: 1 };
  for (const status of ['onboarding','ready','active','suspended','archived']) {
    assert.equal(requireOwnedSyntheticTenantArchival(owned,{ ...tenant,status }),true);
  }
  assert.throws(()=>requireTenantLifecycleTransition({ currentStatus: 'onboarding',targetStatus: 'archived' }),/TRANSITION_DENIED/);
  for (const patch of [{ mode: 'real' },{ operatorId: randomUUID() },{ generationId: randomUUID() },
    { environment: 'dev' },{ status: 'pending' },{ slot: 'unknown' },{ revision: 0 },{ tenantId: null }]) {
    assert.throws(()=>requireOwnedSyntheticTenantArchival(owned,{ ...tenant,...patch }),/ARCHIVAL_DENIED/);
  }
  assert.throws(()=>requireOwnedSyntheticTenantArchival({ ...owned,environment: 'prod' },tenant),/ARCHIVAL_DENIED/);
});

test('a directly supplied elevated principal cannot manufacture the required owner-stamped repository execution scope',async()=>{
  const queries=[],client={ async query(value) { queries.push(value);return { rowCount: 0,rows: [] }; },release() {} };
  const pool={ async connect() { return client; } };
  const audit={ async appendWithClient() { assert.fail('AUDIT_REACHED_WITHOUT_SCOPE'); } };
  const repository=createPostgresSyntheticGenerationRepository(pool,{ ...scope,tenantAuditRepository: audit,
    platformAuditRepository: audit });
  await assert.rejects(repository.replace({ principal: principal(),intent,correlationId }),
    { code: 'PROTECTED_SYNTHETIC_EXECUTION_REQUIRED' });
  assert.deepEqual(queries,['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE',"SET LOCAL TIME ZONE 'UTC'",'ROLLBACK']);
});

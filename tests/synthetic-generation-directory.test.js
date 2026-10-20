import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { normalizeSyntheticGenerationDirectory } from '../src/domain/synthetic-generation-directory.js';
import { createPostgresSyntheticGenerationDirectoryRepository }
  from '../src/persistence/postgres/platform-synthetic-generation-directory-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const epoch=randomUUID(),now=new Date('2026-10-20T12:00:00.000Z'),operatorId=randomUUID();
function principal(roles=['platform_tenant_operator']) {
  return { operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: 'directory',subjectReference: 'subject' },
    targetScope: { mode: 'allowlist',securityVersion: 3 },
    assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: now.toISOString() },
    session: { id: randomUUID(),issuedAt: now.toISOString(),expiresAt: new Date(now.getTime()+3_600_000).toISOString(),
      securityVersion: 3,securityEpoch: 7,stepUpExpiresAt: null } };
}
function fixture() {
  const calls=[];let held=false;const state={ source: true,history: [],tenants: [] };
  const client={ async query(input) {
    calls.push(input);
    if (input?.name==='synthetic-generation-directory-current-source') return { rowCount: state.source ? 1 : 0,rows: [{ now }] };
    if (input?.name==='synthetic-generation-directory-own-history') return { rowCount: state.history.length,rows: state.history };
    if (input?.name==='synthetic-generation-directory-own-tenants') return { rowCount: state.tenants.length,rows: state.tenants };
    return { rowCount: 0,rows: [] };
  },release() { held=false; } };
  const pool={ query() { assert.fail('UNBOUND_POOL_READ'); },async connect() { assert.equal(held,false);held=true;return client; } };
  const leasePool={ query() { assert.fail('UNBOUND_LEASE_READ'); },async connect() {
    return { async query() { return { rowCount: 1,rows: [{ acquired: true }] }; },release() {} };
  } };
  const scope={ environment: 'int',securityEpoch: epoch },scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,...scope });
  const repository=createPostgresSyntheticGenerationDirectoryRepository(pool,{ ...scope,platformSecurityEpoch: 7 });
  return { state,calls,pool,client,scopes,repository };
}
function active() {
  return { id: randomUUID(),state: 'active',revision: 2,security_epoch: epoch,operator_security_version: 3,
    created_at: new Date(now.getTime()-20_000),activated_at: new Date(now.getTime()-20_000),archived_at: null };
}
function tenants() {
  return ['northwind','contoso','fabrikam'].map((slot,index)=>({ slot,tenant_id: randomUUID(),
    status: ['active','ready','onboarding'][index] }));
}

test('own directory requires live exact shared custody and current actual MFA source, while max1 RR reads join safely',async()=>{
  const f=fixture(),actor=principal();
  await assert.rejects(f.repository.current(actor),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });assert.equal(f.calls.length,0);
  await f.scopes.withShared(async()=>{
    assert.deepEqual(await f.repository.current(actor),{ generation: null,retainedGenerations: 0,canReplace: true,replaceAfter: null });
    await withPostgresTransaction(f.pool,async()=>assert.equal((await f.repository.current(actor)).generation,null),
      { isolationLevel: 'REPEATABLE READ' });
  });
  const binding=f.calls.find(call=>call?.name==='synthetic-generation-directory-current-source').values;
  assert.equal(binding[0],operatorId);assert.equal(binding[2],actor.session.id);assert.deepEqual(binding[6],actor.roles);
  f.state.source=false;
  await assert.rejects(f.scopes.withShared(()=>f.repository.current(actor)),{ name: 'PlatformAuthorizationError' });
  const before=f.calls.length;
  await assert.rejects(f.scopes.withShared(()=>f.repository.current(principal(['platform_support_reader']))),
    { name: 'PlatformAuthorizationError' });assert.equal(f.calls.length,before);
});

test('stale owned metadata retains its replacement revision without availability; retention/cooldown remain bounded',async()=>{
  const f=fixture(),actor=principal(),row=active();f.state.history=[row];f.state.tenants=tenants();
  const read=()=>f.scopes.withShared(()=>f.repository.current(actor));
  const original=await read();assert.equal(original.generation.available,true);assert.equal(original.canReplace,true);
  assert.deepEqual(original.generation.tenants.map(tenant=>tenant.status),['active','ready','onboarding']);
  for (const change of [{ security_epoch: randomUUID() },{ operator_security_version: 2 }]) {
    f.state.history=[{ ...row,...change }];const stale=await read();
    assert.equal(stale.generation.available,false);assert.equal(stale.generation.generationId,row.id);
    assert.equal(stale.generation.revision,2);
  }
  f.state.history=[{ ...row,activated_at: new Date(now.getTime()-1000) }];
  const cooldown=await read();assert.equal(cooldown.canReplace,false);
  assert.equal(cooldown.replaceAfter,new Date(now.getTime()+9000).toISOString());
  f.state.history=[row,...Array.from({ length: 31 },()=>({ ...active(),state: 'archived',archived_at: new Date(now.getTime()-20_000) }))];
  const full=await read();assert.equal(full.retainedGenerations,32);assert.equal(full.canReplace,false);
  f.state.history.push({ ...active(),state: 'archived' });await assert.rejects(read(),/DIRECTORY_INVALID/);
});

test('malformed current sets and directory output fail closed without hidden authority fields or incomplete tenants',async()=>{
  const f=fixture(),actor=principal(),read=()=>f.scopes.withShared(()=>f.repository.current(actor));
  f.state.history=[active(),active()];await assert.rejects(read(),/DIRECTORY_INVALID/);
  f.state.history=[{ ...active(),state: 'preparing' }];await assert.rejects(read(),/DIRECTORY_INVALID/);
  f.state.history=[active()];f.state.tenants=tenants().slice(0,2);await assert.rejects(read(),/DIRECTORY_INVALID/);
  const value={ generation: null,retainedGenerations: 0,canReplace: true,replaceAfter: null };
  for (const bad of [{ ...value,operatorId },{ ...value,retainedGenerations: 33 },{ ...value,replaceAfter: now.toISOString() },
    Object.create(value),Object.defineProperty({ ...value },'hidden',{ value: 'authority' })]) {
    assert.throws(()=>normalizeSyntheticGenerationDirectory(bad),/DIRECTORY_INVALID/);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedPlatformTenantCustodySql } from '../src/persistence/postgres/protected-platform-tenant-custody.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { createPostgresPlatformReadinessSnapshotRepository,
  createPostgresPlatformMicrosoftHealthSnapshotRepository } from '../src/persistence/postgres/platform-operations-read-model-repository.js';
const EPOCH='ba000000-0000-4000-8000-000000000001',OPERATOR='ba000000-0000-4000-8000-000000000002';
const profile={ environment: 'int',securityEpoch: EPOCH };

test('protected custody accepts only closed immutable server configuration and bounded SQL references',()=>{
  assert.equal(createProtectedPlatformTenantCustodySql(),null);
  for (const value of [{},{ ...profile,mode: 'all' },{ ...profile,environment: 'demo' },{ ...profile,securityEpoch: 'unknown' },
    Object.defineProperty({ environment: 'int' },'securityEpoch',{ get() { assert.fail('ACCESSOR_NOT_EXECUTED'); },enumerable: true })]) {
    assert.throws(()=>createProtectedPlatformTenantCustodySql(value),/CONFIGURATION_INVALID/);
  }
  const input={ ...profile },custody=createProtectedPlatformTenantCustodySql(input);input.environment='prod';
  assert.deepEqual(custody.cursorScope,profile);assert.ok(Object.isFrozen(custody.cursorScope));
  for (const tenant of ['tenant; DELETE FROM tenants','tenant.id OR true','request.tenantId']) {
    assert.throws(()=>custody.predicate({ tenant,firstParameter: 4 }),/TENANT_INVALID/);
  }
  for (const firstParameter of [-1,0,100,Infinity,'4']) {
    assert.throws(()=>custody.predicate({ tenant: 'tenant.id',firstParameter }),/PARAMETER_INVALID/);
  }
});

test('custody binds deployment values separately and keeps REAL policy distinct from own live synthetic ownership',()=>{
  const value=createProtectedPlatformTenantCustodySql(profile).predicate({ tenant: 'tenant.id',firstParameter: 10,modeParameter: 3 });
  assert.deepEqual(value.values,['int',EPOCH]);assert.ok(Object.isFrozen(value.values));
  for (const text of [value.sql,value.syntheticSql,value.deploymentSql]) assert.equal(text.includes(EPOCH),false);
  assert.match(value.sql,/mode='real'/);assert.doesNotMatch(value.syntheticSql,/mode='real'/);
  for (const text of [value.sql,value.syntheticSql]) {
    assert.match(text,/protected_generation\.state='active'/);assert.match(text,/security_epoch=\$11::uuid/);
    assert.match(text,/protected_registry\.operator_id=\$1::uuid/);assert.match(text,/operator_security_version=\$2/);
    assert.match(text,/protected_actor\.scope_mode=\$3/);assert.match(text,/\$10<>'prod'/);
  }
  assert.throws(()=>createPostgresPlatformPersistence({}, { protectedRuntime: {} }),/CUSTODY_CONFIGURATION_INVALID/);
});

for (const [name,create,query] of [
  ['readiness',createPostgresPlatformReadinessSnapshotRepository,{ readinessState: null,blockerCode: null }],
  ['health',createPostgresPlatformMicrosoftHealthSnapshotRepository,{ capability: null,healthStatus: null,incidentScope: null }],
]) test(`${name} pagination binds protected environment/epoch and denies a cursor from another custody before I/O`,async()=>{
  const statements=[],ids=['ba000000-0000-4000-8000-000000000003','ba000000-0000-4000-8000-000000000004'];
  const pool={ async query(statement) {
    statements.push(statement);
    if (statement.text.includes('clock_timestamp')) return { rows: [{ snapshot_at: new Date('2026-10-21T06:00:00.000Z') }] };
    // Empty model fields are intentional: cursor scope, not presentation, is the assertion here.
    return { rows: ids.map(tenant_id=>({ tenant_id,blocker_codes: [],checks: [],capabilities: [],evidence: [] })) };
  } };
  const authorization={ targetAuthorization: { mode: 'all',operatorId: OPERATOR,securityVersion: 3 } };
  const first=create(pool,{ cursorSecret: 'x'.repeat(48),protectedRuntime: profile });
  const result=await first.list({ query: { limit: 1,cursor: null,lifecycleStatus: null,...query },authorization });
  assert.ok(result.nextCursor);const page=statements.at(-1);
  assert.deepEqual(page.values.slice(-2),['int',EPOCH]);assert.match(page.text,/tenant_runtime_registry/);
  const count=statements.length,foreign=create(pool,{ cursorSecret: 'x'.repeat(48),
    protectedRuntime: { ...profile,securityEpoch: ids[0] } });
  await assert.rejects(foreign.list({ query: { limit: 1,cursor: result.nextCursor,lifecycleStatus: null,...query },authorization }),
    /PLATFORM_OPERATION_CURSOR_INVALID/);assert.equal(statements.length,count);
});

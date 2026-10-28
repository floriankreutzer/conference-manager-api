import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresProtectedRuntimeReadiness } from '../src/persistence/postgres/protected-runtime-readiness.js';
import { protectedRuntimeRoleRequirements } from '../src/persistence/postgres/protected-runtime-role-requirements.js';
import { CURRENT_SCHEMA_VERSION } from '../src/persistence/postgres/pool.js';

const EPOCH='be000000-0000-4000-8000-000000000001';
function fixture() {
  const queries=[];let schema=CURRENT_SCHEMA_VERSION,allowed=true,participantAllowed=true,failed=false,leased=false;
  const pool={ async query(query) {
    assert.equal(leased,true);queries.push(query);
    if (failed) throw new Error('PRIVATE_DATABASE_DETAIL');
    if (query.name?.startsWith('protected-participant-role-posture-')) return { rowCount: 1,rows: [{ allowed: participantAllowed }] };
    return query.name==='schema-readiness' ? { rows: [{ version: schema }] } : { rowCount: 1,rows: [{ allowed }] };
  },connect() { assert.fail('BUSINESS_CONNECTION_MUST_BE_FREE'); } };
  const leasePool={ query() { assert.fail('NO_DIRECT_LEASE_READ'); },async connect() {
    assert.equal(leased,false);leased=true;
    return { async query(input) { queries.push(input);return { rowCount: 1,rows: [{ acquired: true }] }; },
      release() { leased=false; } };
  } };
  return { pool,queries,scope: { leasePool,environment: 'int',securityEpoch: EPOCH,surface: 'customer' },
    setParticipantAllowed(value) { participantAllowed=value; },setSchema(value) { schema=value; },
    setAllowed(value) { allowed=value; },fail() { failed=true; },leased: ()=>leased };
}

test('protected readiness fixes the surface role, current schema and exact shared lease without exposing an executor or grant',async()=>{
  const f=fixture(),readiness=createPostgresProtectedRuntimeReadiness(f.pool,f.scope);
  assert.deepEqual(Object.keys(readiness),['isReady']);assert.ok(Object.isFrozen(readiness));
  assert.equal(await readiness.isReady(),true);assert.equal(f.leased(),false);
  const query=f.queries.find(value=>value?.name==='protected-runtime-role-posture-customer');
  assert.equal(query.values[0],'cm_protected_int_customer');
  assert.deepEqual(query.values.slice(1),Object.values(protectedRuntimeRoleRequirements('customer')));
  assert.equal(f.queries.at(-1),'COMMIT');
  f.setAllowed('true');assert.equal(await readiness.isReady(),false);
  f.setSchema(CURRENT_SCHEMA_VERSION-1);assert.equal(await readiness.isReady(),false);
});

test('readiness dependency errors close availability and release the lease without leaking driver detail',async()=>{
  const f=fixture();f.fail();const readiness=createPostgresProtectedRuntimeReadiness(f.pool,f.scope);
  assert.equal(await readiness.isReady(),false);assert.equal(f.leased(),false);assert.equal(f.queries.at(-1),'ROLLBACK');
});

test('malformed surface/scope/pools cannot select a privileged role or acquire any database resource',()=>{
  const f=fixture();
  for (const change of [{ surface: 'admin' },{ environment: 'demo' },{ securityEpoch: 'invalid' },{ leasePool: f.pool }]) {
    assert.throws(()=>createPostgresProtectedRuntimeReadiness(f.pool,{ ...f.scope,...change }));
  }
  assert.equal(f.queries.length,0);
  const policy=protectedRuntimeRoleRequirements('platform');assert.ok(Object.isFrozen(policy));
  for (const value of Object.values(policy)) assert.ok(Object.isFrozen(value));
  assert.ok(policy.forbiddenInsert.includes('platform_passkey_enrollment_grants'));
});

test('enabled participant readiness verifies exact function/table privileges inside the existing shared lease',async()=>{
  for (const surface of ['customer','platform']) {
    const f=fixture(),readiness=createPostgresProtectedRuntimeReadiness(f.pool,
      { ...f.scope,surface,syntheticParticipantsEnabled: true });
    assert.equal(await readiness.isReady(),true);
    const query=f.queries.find(value=>value?.name===`protected-participant-role-posture-${surface}`);
    assert.ok(query);assert.doesNotMatch(query.text,/GRANT|REVOKE|INSERT INTO|UPDATE /);
    if (surface==='customer') {
      assert.match(query.text,/protected_synthetic_participant_lifecycle/);
      assert.match(query.text,/AND NOT has_function_privilege/);
    } else assert.match(query.text,/AND NOT has_any_column_privilege/);
    assert.equal(f.leased(),false);assert.equal(f.queries.at(-1),'COMMIT');
    f.setParticipantAllowed(false);assert.equal(await readiness.isReady(),false);
    f.setParticipantAllowed('true');assert.equal(await readiness.isReady(),false);
  }
  const f=fixture();
  for (const syntheticParticipantsEnabled of ['true',null,1]) {
    assert.throws(()=>createPostgresProtectedRuntimeReadiness(f.pool,{ ...f.scope,syntheticParticipantsEnabled }),/CONFIGURATION_INVALID/);
  }
  assert.throws(()=>createPostgresProtectedRuntimeReadiness(f.pool,
    { ...f.scope,environment: 'prod',syntheticParticipantsEnabled: true }),/CONFIGURATION_INVALID/);
  assert.equal(f.queries.length,0);
});

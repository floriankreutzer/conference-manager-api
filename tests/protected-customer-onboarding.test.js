import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPostgresProtectedPlatformCustomerOnboardingRepository }
  from '../src/persistence/postgres/platform-protected-customer-onboarding-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';

const epoch=randomUUID(),configuration={ environment: 'int',securityEpoch: epoch,
  cipher: { platformCreationDigest() {},seal() {},open() {},recipientLookup() {} },content: { invitation() {} },
  tenantAuditRepository: { appendWithClient() {} },platformAuditRepository: { appendWithClient() {} } };
function fixture(deployment=true) {
  const queries=[];let connected=0;
  const client={ async query(value) { queries.push(value);
    const text=typeof value==='string' ? value : value.text;
    if (text.includes('pg_try_advisory')) return { rowCount: 1,rows: [{ acquired: true }] };
    return { rowCount: deployment ? 1 : 0,rows: [] };
  },release() {} };
  return { queries,pool: { query: value=>client.query(value),async connect() { connected++;return client; } },
    connections: ()=>connected };
}

test('protected onboarding requires a valid server-owned environment and UUID epoch before any database or secret work',()=>{
  const f=fixture();
  for (const patch of [{ environment: 'demo' },{ environment: undefined },{ securityEpoch: null },{ securityEpoch: 'legacy' }]) {
    assert.throws(()=>createPostgresProtectedPlatformCustomerOnboardingRepository(f.pool,{ ...configuration,...patch }),
      /PROTECTED_CUSTOMER_ONBOARDING_CONFIGURATION_INVALID/);
  }
  assert.equal(f.connections(),0);assert.equal(f.queries.length,0);
});

test('ordinary direct calls cannot create an unclassified customer outside the protected enclosing shared lease',async()=>{
  const f=fixture(),repository=createPostgresProtectedPlatformCustomerOnboardingRepository(f.pool,configuration);
  await assert.rejects(repository.create({}),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  assert.equal(f.connections(),0);assert.equal(f.queries.length,0);
});

test('current deployment readback is checked inside the business transaction before ordinary creation, invitations or audit',async()=>{
  const business=fixture(false),lease=fixture(),scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.pool,
    leasePool: lease.pool,environment: 'int',securityEpoch: epoch });
  const repository=createPostgresProtectedPlatformCustomerOnboardingRepository(business.pool,configuration);
  await assert.rejects(scopes.withShared(()=>repository.create({})),/PROTECTED_RUNTIME_SCOPE_STALE/);
  assert.equal(business.connections(),1);
  assert.deepEqual(business.queries.filter(query=>typeof query==='string'),
    ['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE',"SET LOCAL TIME ZONE 'UTC'",'ROLLBACK']);
  const reads=business.queries.filter(query=>typeof query==='object');assert.equal(reads.length,1);
  assert.equal(reads[0].name,'protected-customer-onboarding-deployment-lock');assert.deepEqual(reads[0].values,['int',epoch]);
});

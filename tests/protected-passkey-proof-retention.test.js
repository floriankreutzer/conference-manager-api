import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPostgresProtectedPasskeyProofRetention }
  from '../src/persistence/postgres/platform-protected-passkey-proof-retention.js';
import { createPostgresPlatformPasskeyAuthRepository } from '../src/persistence/postgres/platform-passkey-auth-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction,isPostgresTransactionActive } from '../src/persistence/postgres/transaction.js';

const epoch=randomUUID(),operatorId=randomUUID();
function fixture(respond=()=>({ rowCount: 1,rows: [] })) {
  const queries=[];
  const client={ async query(query) {
    queries.push(query);
    if (query?.text?.includes('pg_try_advisory')) return { rows: [{ acquired: true }] };
    return respond(query);
  },release() {} };
  return { queries,client,pool: { async connect() { return client; },query: query=>client.query(query) } };
}
const record={ operatorId,operatorSecurityVersion: 1,environment: 'int',securityEpoch: 7,purpose: 'login',
  expectedSessionId: null,operationHash: null,id: randomUUID(),correlationId: randomUUID(),stateHash: 'a'.repeat(64),
  browserHash: 'b'.repeat(64),challenge: Buffer.alloc(32,4).toString('base64url'),ttlSeconds: 120 };
const dependencies={ auditRepository: { async appendWithClient() {} },verifier: { async verifyAuthentication() {} } };

test('fixed proof retention requires the exact live shared lease and active business client before any deletion',async()=>{
  const business=fixture(),lease=fixture(),scope={ environment: 'int',securityEpoch: epoch };
  const retention=createPostgresProtectedPasskeyProofRetention(business.pool,scope);
  await assert.rejects(retention.deleteExpiredWithClient(business.client,operatorId),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  assert.equal(business.queries.length,0);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.pool,leasePool: lease.pool,...scope });
  await scopes.withShared(async()=>{
    await assert.rejects(retention.deleteExpiredWithClient(business.client,operatorId),/TRANSACTION_REQUIRED/);
    await withPostgresTransaction(business.pool,async client=>{
      await assert.rejects(retention.deleteExpiredWithClient(lease.client,operatorId),/TRANSACTION_REQUIRED/);
      await assert.rejects(retention.deleteExpiredWithClient(client,'foreign'),/TRANSACTION_REQUIRED/);
      await retention.deleteExpiredWithClient(client,operatorId);
    });
  });
  assert.equal(business.queries.filter(query=>query?.name==='protected-passkey-expired-unreferenced-cleanup').length,1);
});

test('protected retention runs once during challenge creation and never falls back after failure',async()=>{
  for (const failure of [false,true]) {
    const f=fixture(query=>query?.name==='platform-passkey-operator-lock'
      ? { rowCount: 1,rows: [{ id: operatorId }] } : { rowCount: 1,rows: [] });let calls=0;
    const repository=createPostgresPlatformPasskeyAuthRepository(f.pool,{ ...dependencies,
      expiredProofRetention: { async deleteExpiredWithClient(client,id) {
        calls++;assert.equal(client,f.client);assert.equal(id,operatorId);assert.equal(isPostgresTransactionActive(f.pool,client),true);
        if (failure) throw new Error('RETAINED_PROOF_STORE_UNAVAILABLE');
      } } });
    if (failure) await assert.rejects(repository.create(record),/RETAINED_PROOF_STORE_UNAVAILABLE/);
    else assert.equal(await repository.create(record),true);
    assert.equal(calls,1);assert.equal(f.queries.some(query=>query?.name==='platform-passkey-expired-cleanup'),false);
    assert.equal(f.queries.filter(query=>query?.name==='platform-passkey-auth-create').length,failure ? 0 : 1);
    assert.equal(f.queries.at(-1),failure ? 'ROLLBACK' : 'COMMIT');
  }
});

test('ordinary proof storage keeps its existing cleanup when no protected retention port is configured',async()=>{
  const f=fixture(query=>query?.name==='platform-passkey-operator-lock'
    ? { rowCount: 1,rows: [{ id: operatorId }] } : { rowCount: 1,rows: [] });
  const repository=createPostgresPlatformPasskeyAuthRepository(f.pool,dependencies);
  assert.equal(await repository.create(record),true);
  assert.equal(f.queries.filter(query=>query?.name==='platform-passkey-expired-cleanup').length,1);
  assert.throws(()=>createPostgresPlatformPasskeyAuthRepository(f.pool,{ ...dependencies,expiredProofRetention: {} }),/RETENTION_INVALID/);
});

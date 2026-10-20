import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from '../src/persistence/postgres/protected-customer-access-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

const tenantId=randomUUID(),userId=randomUUID(),sessionId=randomUUID(),epoch=randomUUID();
const authorization=tenantAuthorizationSnapshot(['employee']);
const issuedAt=new Date(),expiresAt=new Date(issuedAt.getTime()+3_600_000);
const principal={ tenantId,userId,providerIdentity: { provider: 'email_code',reference: userId },...authorization,
  session: { id: sessionId,securityVersion: 1,issuedAt: issuedAt.toISOString(),expiresAt: expiresAt.toISOString() } };

for (const readOnly of [false,true]) test(`current cookie and invited qualification join max1 transaction, readOnly=${readOnly}`,async()=>{
  const events=[];let connects=0,direct=0;
  function respond(query) {
    events.push(query);
    if (query?.name==='session-resolve-by-token-hash') return { rows: [{ id: sessionId,tenant_id: tenantId,user_id: userId,
      token_hash: 'a'.repeat(64),provider: 'email_code',provider_identity_reference: userId,...authorization,principal_version: 1,
      issued_at: issuedAt,expires_at: expiresAt,tenant_status: 'active' }] };
    if (query?.name==='protected-customer-current-invited-access') return { rowCount: 1,rows: [{ roles: [] }] };
    return { rowCount: 0,rows: [] };
  }
  const client={ query: async query=>respond(query),release() {} };
  const pool={ async connect() { connects++;assert.equal(connects,1);return client; },
    async query(query) { direct++;return respond(query); } };
  const sessions=createPostgresSessionRepository(pool,{ auditRepository: { async appendWithClient() {} } });
  const access=createPostgresProtectedCustomerAccessRepository(pool,{ environment: 'int',securityEpoch: epoch });
  await withPostgresTransaction(pool,async()=>{
    assert.equal((await sessions.resolveByTokenHash('a'.repeat(64),issuedAt)).id,sessionId);
    assert.equal((await access.resolveCurrentAccess({ environment: 'int',securityEpoch: epoch,principal })).kind,'invited_membership');
    assert.equal(direct,0);
  },{ isolationLevel: 'REPEATABLE READ',readOnly });
  assert.equal(connects,1);assert.equal(events.at(-1),'COMMIT');
  assert.equal((await sessions.resolveByTokenHash('a'.repeat(64),issuedAt)).id,sessionId);
  assert.equal((await access.resolveCurrentAccess({ environment: 'int',securityEpoch: epoch,principal })).kind,'invited_membership');
  assert.equal(direct,2);assert.equal(connects,1);
});

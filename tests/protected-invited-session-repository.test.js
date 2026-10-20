import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createPostgresProtectedInvitedSessionRepository } from '../src/persistence/postgres/protected-invited-session-repository.js';
import { isPostgresTransactionActive } from '../src/persistence/postgres/transaction.js';

const EPOCH='d2000000-0000-4000-8000-000000000001',TENANT='d2000000-0000-4000-8000-000000000002';
const USER='d2000000-0000-4000-8000-000000000003',SESSION='d2000000-0000-4000-8000-000000000004';
const authorization=tenantAuthorizationSnapshot(['employee']);
const record={ id: SESSION,tenantId: TENANT,userId: USER,tokenHash: 'a'.repeat(64),
  providerIdentity: { provider: 'email_code',reference: USER },...authorization,expectedSecurityVersion: 1,
  issuedAt: '2026-10-20T12:00:00.000Z',expiresAt: '2026-10-20T13:00:00.000Z' };

function fixture(qualified=true) {
  const events=[],releases=[];let connects=0;
  const client={ async query(value) {
    events.push(value);const name=typeof value==='object' ? value.name : value;
    if (name==='session-security-context-tenant') return { rowCount: 1,rows: [{ tenant_status: 'onboarding' }] };
    if (name==='session-security-context-user') return { rowCount: 1,rows: [{ security_version: 1 }] };
    if (name==='session-insert') return { rowCount: 1,rows: [{ id: SESSION,tenant_id: TENANT,user_id: USER,
      token_hash: record.tokenHash,provider: 'email_code',provider_identity_reference: USER,roles: authorization.roles,
      permissions: authorization.permissions,principal_version: 1,
      issued_at: new Date(record.issuedAt),expires_at: new Date(record.expiresAt) }] };
    if (name==='protected-customer-current-invited-access') {
      assert.equal(isPostgresTransactionActive(pool,client),true);
      return { rowCount: qualified ? 1 : 0,rows: qualified ? [{ roles: ['employee'] }] : [] };
    }
    return { rowCount: 0,rows: [] };
  },release: error=>releases.push(error) };
  const pool={ async connect() { connects++;return client; },async query() { throw new Error('QUALIFICATION_ESCAPED_TRANSACTION'); } };
  const repository=createPostgresProtectedInvitedSessionRepository(pool,{ environment: 'int',securityEpoch: EPOCH,auditRepository: {
    async appendWithClient(value) { assert.equal(value,client);events.push('AUDIT');return { id: '1' }; },
  } });
  return { repository,events,releases,connects: ()=>connects };
}

test('protected session and audit qualify current invited authority on the same single transaction/client',async()=>{
  const f=fixture(),result=await f.repository.issue(record,{});
  assert.equal(result.userId,USER);assert.equal(f.connects(),1);assert.deepEqual(f.releases,[undefined]);
  assert.equal(f.events.at(-1),'COMMIT');
  const names=f.events.map(value=>typeof value==='object' ? value.name : value);
  assert.ok(names.indexOf('session-insert')<names.indexOf('AUDIT'));
  assert.ok(names.indexOf('AUDIT')<names.indexOf('protected-customer-current-invited-access'));
  assert.equal(f.repository.matchesProtectionScope({ environment: 'int',securityEpoch: EPOCH }),true);
  assert.equal(f.repository.matchesProtectionScope({ environment: 'dev',securityEpoch: EPOCH }),false);
});

test('denied classification/custody cannot commit a latent session or issuance audit',async()=>{
  const f=fixture(false);await assert.rejects(f.repository.issue(record,{}),/IDENTITY_NOT_PROVISIONED/);
  assert.equal(f.events.at(-1),'ROLLBACK');assert.equal(f.events.includes('COMMIT'),false);
  assert.equal(f.releases[0]?.message,'TRANSACTION_ABORTED');assert.equal(f.connects(),1);
});

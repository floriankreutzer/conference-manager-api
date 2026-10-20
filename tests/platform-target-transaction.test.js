import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPostgresPlatformOperatorRepository } from '../src/persistence/postgres/platform-operator-repository.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

test('Platform target reads join the proof RR client without requesting another connection or escaping its snapshot',async()=>{
  const operatorId=randomUUID(),tenantId=randomUUID(),queries=[];let connected=0;
  const client={ async query(value) {
    queries.push(value);return { rowCount: 1,rows: [{ scope_mode: 'all' }] };
  },release() {} };
  const pool={ async query() { assert.fail('UNSCOPED_POOL_READ'); },async connect() {
    connected++;assert.equal(connected,1,'SECOND_CONNECTION_INSIDE_PROOF');return client;
  } };
  const operatorRepository=createPostgresPlatformOperatorRepository(pool,{ auditRepository: { appendWithClient() {} } });
  const policy=createPlatformTenantTargetPolicy({ operatorRepository }),roles=['platform_tenant_operator'];
  const now=new Date(),principal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: 'synthetic-directory',subjectReference: operatorId },
    targetScope: { mode: 'all',securityVersion: 3 },assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',
      authenticatedAt: now.toISOString() },session: { id: randomUUID(),securityEpoch: 7,securityVersion: 3,
      issuedAt: now.toISOString(),expiresAt: new Date(now.getTime()+3_600_000).toISOString(),stepUpExpiresAt: null } };
  await withPostgresTransaction(pool,async()=>{
    assert.equal(await policy.authorizeCreation(principal),true);assert.equal(await policy.authorize(principal,tenantId),true);
    assert.equal((await policy.queryScope(principal)).mode,'all');
  },{ isolationLevel: 'REPEATABLE READ' });
  assert.equal(connected,1);assert.equal(queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
  assert.equal(queries.at(-1),'COMMIT');
  assert.deepEqual(queries.filter(value=>typeof value==='object').map(value=>value.name),
    ['platform-operator-target-scope-reference','platform-operator-target-authorize','platform-operator-target-scope-reference']);
});

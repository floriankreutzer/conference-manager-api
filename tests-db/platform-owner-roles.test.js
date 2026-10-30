import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformOwnerBootstrapRepository } from '../src/persistence/postgres/platform-owner-bootstrap-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';

test('native owner role upgrade is exact, one-winner, audited and rolls back atomically on receipt failure',async t=>{
  const pool=createPostgresPool({ mode: 'test',...loadDatabaseConfig(process.env,'test'),databasePoolMax: 3 });
  t.after(()=>pool.end());await migrateUp(pool);
  const expected={ environment: 'int',deploymentEpoch: randomUUID(),directoryId: randomUUID(),subjectId: randomUUID() };
  await pool.query('INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES($1,$2)',['int',expected.deploymentEpoch]);
  const role=(await pool.query('SELECT current_user AS role')).rows[0].role;
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'q'.repeat(48) });
  const create=(options={})=>createPostgresPlatformOwnerBootstrapRepository(pool,
    { expected,expectedOfflineRole: role,auditRepository: audit,...options });
  const request={ ...expected,approvalReference: 'OWNER-ALL-ROLES',correlationId: randomUUID() };
  const boot=await create().initialize(request);
  const sessions=createPlatformSessionService({
    repository: createPostgresPlatformSessionRepository(pool,{ auditRepository: audit }),
    publicOrigin: 'https://ops-int.example.com',csrfSecret: 'c'.repeat(48),securityEpoch: 1,
  });
  const identity=(roles,securityVersion)=>({ operatorId: boot.operatorId,
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: expected.directoryId,
      subjectReference: expected.subjectId },roles,permissions: permissionsForPlatformRoles(roles),securityVersion,
    targetScope: { mode: 'all',securityVersion },assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',
      authenticatedAt: new Date().toISOString() } });
  const prior=await sessions.issue(identity(['platform_security_admin','platform_tenant_operator'],1),{ correlationId: randomUUID() });
  const sessionRequest=value=>({ headers: { cookie: value.setCookie.split(';')[0] } });
  assert.ok(await sessions.resolvePrincipal(sessionRequest(prior)));
  const grant={ ...request,correlationId: randomUUID(),expectedSecurityVersion: 1 };
  await assert.rejects(create({ expectedOfflineRole: 'wrong_owner' }).grantAllOwnerRoles(grant));
  await assert.rejects(create().grantAllOwnerRoles({ ...grant,expectedSecurityVersion: 2 }));
  await assert.rejects(create({ auditRepository: {
    async appendWithClient() { throw new Error('private-cause'); },
  } }).grantAllOwnerRoles(grant));
  await assert.rejects(create({ auditRepository: { async appendWithClient() { return null; } } }).grantAllOwnerRoles(grant));
  const read=async()=>(await pool.query('SELECT roles,security_version FROM platform_operators WHERE id=$1',[boot.operatorId])).rows[0];
  assert.equal(Number((await read()).security_version),1);
  assert.equal((await read()).roles.length,2);
  assert.ok(await sessions.resolvePrincipal(sessionRequest(prior)));
  const results=await Promise.allSettled([create().grantAllOwnerRoles(grant),create().grantAllOwnerRoles(grant)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  assert.deepEqual((await read()).roles,[
    'platform_security_admin','platform_security_auditor','platform_support_reader','platform_tenant_operator',
  ]);
  assert.equal(Number((await read()).security_version),2);
  assert.equal(await sessions.resolvePrincipal(sessionRequest(prior)),null);
  const renewed=await sessions.issue(identity((await read()).roles,2),{ correlationId: randomUUID() });
  assert.deepEqual((await sessions.resolvePrincipal(sessionRequest(renewed))).roles,(await read()).roles);
  await assert.rejects(create().grantAllOwnerRoles({ ...grant,expectedSecurityVersion: 2,correlationId: randomUUID() }));
  const events=await audit.listVerified({ scope: { mode: 'all',operatorId: boot.operatorId,securityVersion: 2 } });
  const receipts=events.filter(row=>row.targetType==='platform_owner_roles');
  assert.equal(receipts.length,1);assert.equal(receipts[0].assuranceLevel,'offline_owner');
  assert.equal(receipts[0].operatorId,null);assert.deepEqual(receipts[0].roles,[]);
  assert.equal(receipts[0].metadata.sessionsRevoked,1);
  assert.equal(receipts[0].newState.roleCount,4);assert.equal(receipts[0].previousState.roleCount,2);
  assert.doesNotMatch(JSON.stringify(receipts),new RegExp(expected.subjectId));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_operator_change_alert_outbox')).rows[0].count,2);
  assert.equal(await rollbackLatest(pool),true); // Empty service identity075 before unchanged074/older guards.
  assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before retained owner067.
  await assert.rejects(rollbackLatest(pool),{ code: '55000' });
});

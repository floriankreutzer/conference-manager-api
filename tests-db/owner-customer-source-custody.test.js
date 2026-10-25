import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformOwnerBootstrapRepository } from '../src/persistence/postgres/platform-owner-bootstrap-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresOwnerCustomerSourceCustody } from '../src/persistence/postgres/platform-owner-customer-source-custody.js';
import { createProtectedPlatformSessions } from '../src/platform/identity/protected-platform-sessions.js';
import { PLATFORM_ROLE,permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

// Actual current SQL/receipt/session/lease custody with isolated native pools.
// Issued normal identities here are fixture inputs, not provider/device MFA.
test('native REAL source preparation requires the bootstrapped all-role owner, current exact source and REAL target under max-one leases',
async t=>{
  const config={ mode: 'test',...loadDatabaseConfig(process.env,'test'),databasePoolMax: 1 };
  const pool=createPostgresPool(config),leasePool=createPostgresPool(config);
  t.after(async()=>{ await leasePool.end();await pool.end(); });await migrateUp(pool);
  const epoch=randomUUID(),directory=randomUUID(),subject=randomUUID(),tenantId=randomUUID();
  const scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.test' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Own REAL target','active')",[tenantId]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[tenantId]);
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'q'.repeat(48) });
  const expected={ environment: 'int',deploymentEpoch: epoch,directoryId: directory,subjectId: subject };
  const offlineRole=(await pool.query('SELECT current_user AS role')).rows[0].role;
  const owner=createPostgresPlatformOwnerBootstrapRepository(pool,{ expected,expectedOfflineRole: offlineRole,auditRepository: audit });
  const boot=await owner.initialize({ ...expected,approvalReference: 'OWNER-REAL-NATIVE',correlationId: randomUUID() });
  const sessions=createProtectedPlatformSessions({ environment: 'int',protectedSecurityEpoch: epoch,securityEpoch: 7,
    publicOrigin: scope.platformOrigin,csrfSecret: 'c'.repeat(48),
    repository: createPostgresPlatformSessionRepository(pool,{ auditRepository: audit }) });
  const issue=(operatorId,roles,securityVersion,tenantReference=directory,subjectReference=subject)=>sessions.issue({
    operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion,targetScope: { mode: 'all',securityVersion },
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference,subjectReference },
    assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: new Date().toISOString() } });
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch: epoch });
  const custody=createPostgresOwnerCustomerSourceCustody(pool,{ scope });
  const selection={ flowId: randomUUID(),operatorId: boot.operatorId,tenantId,role: 'tenant_admin' };
  const read=(principal,target=selection)=>scopes.withShared(()=>withPostgresTransaction(pool,
    client=>custody.currentWithClient(client,{ principal,selection: target })));
  const roles=Object.values(PLATFORM_ROLE).sort(),initial=await issue(boot.operatorId,
    ['platform_security_admin','platform_tenant_operator'],1);
  await assert.rejects(read(initial.principal),/OWNER_CUSTOMER_ACCESS_DENIED/);
  const claimed={ ...initial.principal,roles,permissions: permissionsForPlatformRoles(roles) };
  assert.equal(await read(claimed),null); // Claims cannot replace the actual all-role upgrade/receipt.
  await owner.grantAllOwnerRoles({ ...expected,approvalReference: 'OWNER-REAL-ALL-ROLES',
    expectedSecurityVersion: 1,correlationId: randomUUID() });
  const current=await issue(boot.operatorId,roles,2),principal=current.principal;
  await assert.rejects(custody.currentWithClient(pool,{ principal,selection }),/PROTECTED_SHARED_EXECUTION_REQUIRED/);
  await assert.rejects(scopes.withShared(()=>custody.currentWithClient(pool,{ principal,selection })),/TRANSACTION_REQUIRED/);
  // Platform persistence uses database clock_timestamp() (microseconds), while
  // its canonical Principal mapper exposes JS Date ISO values (milliseconds).
  const precision=(await pool.query(`SELECT date_trunc('milliseconds',issued_at)=$2 AS issued_matches,
    date_trunc('milliseconds',expires_at)=$3 AS expires_matches FROM platform_sessions WHERE id=$1`,
  [principal.session.id,principal.session.issuedAt,principal.session.expiresAt])).rows[0];
  assert.deepEqual(precision,{ issued_matches: true,expires_matches: true });
  const accepted=await read(principal);
  assert.ok(accepted,'OWNER_CURRENT_SOURCE_REQUIRED');
  assert.equal(accepted.operatorId,boot.operatorId);assert.equal(accepted.tenantId,tenantId);
  assert.equal(accepted.sourceSessionId,principal.session.id);assert.equal(accepted.sourceExpiresAt,principal.session.expiresAt);
  assert.notEqual(accepted.bootstrapAuditSequence,accepted.ownerRolesAuditSequence);
  assert.equal(await read(principal,{ ...selection,tenantId: randomUUID() }),null);
  assert.equal(await read({ ...principal,session: { ...principal.session,id: randomUUID() } }),null);
  for (const field of ['issuedAt','expiresAt']) {
    const altered=new Date(Date.parse(principal.session[field])+1).toISOString();
    assert.equal(await read({ ...principal,session: { ...principal.session,[field]: altered } }),null);
  }
  assert.equal(await read({ ...principal,providerIdentity: { ...principal.providerIdentity,subjectReference: randomUUID() } }),null);
  await pool.query("UPDATE tenants SET status='suspended' WHERE id=$1",[tenantId]);
  assert.equal(await read(principal),null);
  await pool.query("UPDATE tenants SET status='active' WHERE id=$1",[tenantId]);assert.ok(await read(principal));
  const other=randomUUID(),otherSubject=randomUUID();
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles,scope_mode)
    VALUES($1,'microsoft_entra_platform',$2,$3,$4,'all')`,[other,directory,otherSubject,roles]);
  const otherSession=await issue(other,roles,1,directory,otherSubject);
  assert.equal(await read(otherSession.principal,{ ...selection,operatorId: other }),null);
  await sessions.revoke(principal);assert.equal(await read(principal),null);
  const renewed=await issue(boot.operatorId,roles,2);assert.ok(await read(renewed.principal));
  await pool.query("UPDATE platform_operators SET roles=ARRAY['platform_security_admin','platform_tenant_operator'] WHERE id=$1",
    [boot.operatorId]);
  assert.equal(await read(renewed.principal),null);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_credentials')).rows[0].count,0);
  assert.ok(await audit.isReady());
});

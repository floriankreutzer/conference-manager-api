import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { requireCurrentPlatformMutationAuthorization } from '../src/persistence/postgres/platform-operations-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy,PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createPlatformOperationEvidenceFactory } from '../src/persistence/postgres/platform-operations-evidence.js';
import { createPlatformDiagnosticOperationsService } from '../src/platform/application/diagnostic-operations-service.js';
import { createPostgresPlatformDiagnosticRepository }
  from '../src/persistence/postgres/platform-operations-read-model-repository.js';

test('native protected target custody keeps REAL allowlists and current own synthetic targets across pagination, reset and epoch rotation',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch };
  const config={ mode: 'test',...database,databasePoolMax: 1,auditHmacSecret: 'a'.repeat(48),
    tenantAuditHmacSecret: 'a'.repeat(48),cursorSecret: 'k'.repeat(48) };
  const persistence=createPostgresPlatformPersistence(config,{ protectedRuntime: scope }),pool=persistence.pool;
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await persistence.close();await leasePool.end(); });await migrateUp(pool);
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const visible=await createInvitedCustomerFixture(pool,t,{ recipient: 'Visible@example.test' });
  const hidden=await createInvitedCustomerFixture(pool,t,{ recipient: 'Hidden@example.test' });
  for (const tenant of [visible,hidden]) {
    await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[tenant.tenantId]);
  }
  const unknown=randomUUID();
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Unclassified fixture','onboarding')",[unknown]);
  const all=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch,scopeMode: 'all' });
  function service(actor) {
    return createSyntheticGenerationService({ ...scope,passkeyService: actor.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
      repository: createPostgresSyntheticGenerationRepository(pool,{ ...scope,tenantAuditRepository: visible.auditRepository,
        platformAuditRepository: actor.auditRepository }) });
  }
  async function replace(actor,previous=null) {
    const application=service(actor),intent={ operatorId: actor.operatorId,expectedGenerationId: previous?.generationId ?? null,
      expectedRevision: previous?.revision ?? 0 };
    return actor.execute(application.operationHash(intent),proofContext=>application.replace({
      proofContext,intent,correlationId: randomUUID() }));
  }
  const foreign=await replace(all);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch,scopeMode: 'allowlist' });
  // An explicit legacy allowlist entry must not expose another owner's synthetic Tenant.
  for (const id of [visible.tenantId,foreign.tenants[0].tenantId]) {
    await pool.query('INSERT INTO platform_operator_tenant_scopes(operator_id,tenant_id) VALUES($1,$2)',[owner.operatorId,id]);
  }
  await owner.freshSession();const first=await replace(owner);
  const ownIds=first.tenants.map(row=>row.tenantId),foreignIds=foreign.tenants.map(row=>row.tenantId);
  const authorization=actor=>({ principal: actor.current().principal,permission: PLATFORM_PERMISSION.LIFECYCLE_MANAGE,
    targetAuthorization: { mode: actor.current().principal.targetScope.mode,operatorId: actor.operatorId,
      securityVersion: actor.current().principal.securityVersion } });
  async function targets(actor,ids,expected) {
    await actor.scopes.withShared(async()=>{
      for (let index=0;index<ids.length;index++) {
        assert.equal(await persistence.operatorRepository.isTenantAllowed({ operatorId: actor.operatorId,tenantId: ids[index],
          securityVersion: actor.current().principal.securityVersion }),expected[index]);
      }
    });
  }
  async function page(actor,reader,filters={},cursor=null) {
    return actor.scopes.withShared(()=>reader.list({ query: { limit: 2,cursor,lifecycleStatus: null,...filters },
      authorization: authorization(actor) }));
  }
  async function collect(actor,reader,filters={}) {
    const ids=[];let cursor=null;
    for (let index=0;index<10;index++) {
      const result=await page(actor,reader,filters,cursor);ids.push(...result.items.map(row=>row.tenantId));
      if (result.nextCursor===null) return ids.sort();cursor=result.nextCursor;
    }
    assert.fail('BOUNDED_DIRECTORY_DID_NOT_TERMINATE');
  }
  const directory=persistence.tenantOperationsRepository.directoryReader;
  const expected=[visible.tenantId,...ownIds].sort();
  assert.deepEqual(await collect(owner,directory,{ search: null }),expected);
  assert.deepEqual(await collect(all,directory,{ search: null }),[visible.tenantId,hidden.tenantId,...foreignIds].sort());
  await targets(owner,[visible.tenantId,hidden.tenantId,unknown,...ownIds,...foreignIds],
    [true,false,false,true,true,true,false,false,false]);
  await targets(all,[visible.tenantId,hidden.tenantId,unknown,...foreignIds,...ownIds],
    [true,true,false,true,true,true,false,false,false]);
  // Actual ordinary projections, not manufactured snapshot rows, exercise both fleet readers.
  await owner.scopes.withShared(()=>persistence.projectionRepository.refreshBatch({ limit: 100 }));
  const readiness={ readinessState: null,blockerCode: null };
  const health={ capability: null,healthStatus: null,incidentScope: null };
  assert.deepEqual(await collect(owner,persistence.readinessSnapshotRepository,readiness),expected);
  assert.deepEqual(await collect(owner,persistence.microsoftHealthSnapshotRepository,health),expected);
  // A missing deployment observation must not erase the actual tenant/health facts.
  const platformAuthorizationPolicy=createPlatformAuthorizationPolicy();
  const tenantTargetPolicy=createPlatformTenantTargetPolicy({ operatorRepository: persistence.operatorRepository });
  const platformAuditService=createPlatformAuditService({ repository: owner.auditRepository,
    authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy });
  const operationEvidenceFactory=createPlatformOperationEvidenceFactory({ platformAuditService,
    tenantAuditService: createAuditService({ repository: visible.auditRepository,authorizationPolicy: createAuthorizationPolicy() }) });
  const diagnostics=reader=>createPlatformDiagnosticOperationsService({ diagnosticReader: reader,
    platformAuthorizationPolicy,tenantTargetPolicy,operationEvidenceFactory });
  const input=tenantId=>({ operatorContext: owner.current().principal,tenantId,correlationId: randomUUID() });
  const ownSummary=await owner.scopes.withShared(()=>diagnostics(persistence.diagnosticRepository).getTenantSummary(input(ownIds[0])));
  assert.equal(ownSummary.summary.tenant.tenantId,ownIds[0]);
  assert.equal(ownSummary.summary.tenant.lifecycleStatus,'active');
  assert.deepEqual(ownSummary.summary.deployment,{ release: null,observedAt: null });
  assert.equal(ownSummary.summary.microsoft.connectionState,'not_configured');
  assert.ok(Number.isSafeInteger(ownSummary.summary.entitlements.enabledCount));
  await assert.rejects(owner.scopes.withShared(()=>diagnostics(persistence.diagnosticRepository)
    .getTenantSummary(input(foreignIds[0]))),/PLATFORM_TENANT_TARGET_DENIED/);
  const auditCount=async()=>Number((await pool.query('SELECT count(*) AS count FROM platform_audit_events')).rows[0].count);
  const beforeAudit=await auditCount();
  const refusing=createPostgresPlatformDiagnosticRepository(pool,{ protectedRuntime: scope,platformAuditRepository: {
    async appendWithClient(...args) { await owner.auditRepository.appendWithClient(...args);throw new Error('AUDIT_PROBE_REFUSED'); },
  } });
  await assert.rejects(owner.scopes.withShared(()=>diagnostics(refusing).getTenantSummary(input(ownIds[0]))),/AUDIT_PROBE_REFUSED/);
  assert.equal(await auditCount(),beforeAudit);
  await owner.scopes.withShared(()=>withPostgresTransaction(pool,async client=>{
    assert.equal(await requireCurrentPlatformMutationAuthorization(client,authorization(owner),ownIds[1],{ protectedRuntime: scope }),
      owner.operatorId);
    await assert.rejects(requireCurrentPlatformMutationAuthorization(client,authorization(owner),foreignIds[0],{ protectedRuntime: scope }),
      /PLATFORM_TENANT_TARGET_DENIED/);
  }));
  // Diagnostics own their canonical RR transaction; do not nest it under an RC probe.
  await assert.rejects(owner.scopes.withShared(()=>persistence.diagnosticRepository.readSummaryAndRecordAccess({
    tenantId: foreignIds[0],authorization: authorization(owner),evidence: null })),/PLATFORM_TENANT_TARGET_DENIED/);
  const cursor=(await page(owner,directory,{ search: null })).nextCursor;assert.ok(cursor);
  const changed=createPostgresPlatformPersistence(config,{ protectedRuntime: { ...scope,securityEpoch: randomUUID() } });
  t.after(()=>changed.close());
  await assert.rejects(changed.tenantOperationsRepository.directoryReader.list({
    query: { limit: 2,cursor,lifecycleStatus: null,search: null },
    authorization: authorization(owner) }),/PLATFORM_OPERATION_CURSOR_INVALID/);
  await new Promise(resolve=>setTimeout(resolve,10_100));const next=await replace(owner,first);
  const current=[visible.tenantId,...next.tenants.map(row=>row.tenantId)].sort();
  assert.deepEqual(await collect(owner,directory,{ search: null }),current);
  await targets(owner,ownIds,[false,false,false]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM rooms WHERE tenant_id=$1',[ownIds[0]])).rows[0].count,10);
  for (const tenant of [visible,hidden]) assert.equal(await tenant.auditRepository.verifyTenantChain(tenant.tenantId),true);
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[randomUUID()]);
  await assert.rejects(owner.scopes.withShared(()=>directory.list({ query: { limit: 2,cursor: null,lifecycleStatus: null,search: null },
    authorization: authorization(owner) })),/PROTECTED_RUNTIME_SCOPE_STALE/);
  assert.equal(await persistence.operatorRepository.isTenantAllowed({ operatorId: owner.operatorId,tenantId: visible.tenantId,
    securityVersion: owner.current().principal.securityVersion }),false);
});

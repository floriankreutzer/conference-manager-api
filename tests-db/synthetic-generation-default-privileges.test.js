import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';

test('default generation replacement uses a restricted legacy Platform role without optional participant table grants',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),pools=[];
  function database(url) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max: 1,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href),lease=database(fixture.url.href);
  t.after(async()=>{ try { await Promise.all(pools.map(value=>value.end())); } finally { await fixture.destroy(); } });
  await migrateUp(pool);const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  assert.match(fixture.password,/^[a-f0-9]{64}$/);
  for (const surface of ['customer','platform']) {
    await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${fixture.password}'`);
  }
  await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: epoch });
  await pool.query('REVOKE SELECT,INSERT ON synthetic_invited_memberships FROM cm_protected_int_platform');
  const url=new URL(fixture.url);url.username='cm_protected_int_platform';
  const runtime=database(url.href),runtimeLease=database(url.href);
  async function privilege() {
    return (await runtime.query(`SELECT current_user AS role,
      has_table_privilege(current_user,'synthetic_invited_memberships','SELECT') AS binding_read,
      has_table_privilege(current_user,'synthetic_invited_memberships','INSERT') AS binding_write,
      has_table_privilege(current_user,'customer_access_memberships','SELECT') AS membership_read`)).rows[0];
  }
  const expected={ role: 'cm_protected_int_platform',binding_read: false,binding_write: false,membership_read: true };
  assert.deepEqual(await privilege(),expected);
  await assert.rejects(runtime.query('SELECT membership_id FROM synthetic_invited_memberships LIMIT 1'),{ code: '42501' });
  const owner=await createProtectedSyntheticMicrosoftFixture(pool,lease,{ epoch,scopeMode: 'all',
    runtimePool: runtime,runtimeLeasePool: runtimeLease });
  const audit=createPostgresAuditRepository(runtime,{ hmacSecret: 'a'.repeat(48) });
  const application=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,assuranceMode: 'microsoft_mfa',
    passkeyService: owner.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
    repository: createPostgresSyntheticGenerationRepository(runtime,{ environment: 'int',securityEpoch: epoch,
      assuranceMode: 'microsoft_mfa',tenantAuditRepository: audit,platformAuditRepository: owner.auditRepository }) });
  function replace(previous=null) {
    const intent={ operatorId: owner.operatorId,expectedGenerationId: previous?.generationId ?? null,
      expectedRevision: previous?.revision ?? 0 };
    return owner.execute(application.operationHash(intent),proofContext=>application.replace({
      proofContext,intent,correlationId: randomUUID() }));
  }
  const first=await replace();
  // Actual domain cooldown; no clock rewrite, shortened budget or retry.
  await new Promise(resolve=>setTimeout(resolve,10100));
  const second=await replace(first);
  assert.ok(second.tenants.every(row=>!first.tenants.some(old=>old.tenantId===row.tenantId)));
  assert.deepEqual((await pool.query('SELECT status FROM tenants WHERE id=ANY($1::uuid[])',
    [first.tenants.map(row=>row.tenantId)])).rows.map(row=>row.status),['archived','archived','archived']);
  await createInvitedCustomerFixture(pool,t,{ targetTenantId: second.tenants[0].tenantId,accept: false });
  async function state() {
    return (await pool.query(`SELECT jsonb_build_object(
      'generation',(SELECT to_jsonb(g) FROM synthetic_tenant_generations g WHERE id=$1),
      'tenants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tenants t WHERE id=ANY($2::uuid[])),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM customer_access_memberships m),
      'invitations',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM customer_member_invitations i),
      'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY tenant_id,id) FROM audit_events a WHERE tenant_id=ANY($2::uuid[]))
      ) AS value`,[second.generationId,second.tenants.map(row=>row.tenantId)])).rows[0].value;
  }
  await new Promise(resolve=>setTimeout(resolve,10100));
  const before=await state();
  await assert.rejects(replace(second),/^Error: SYNTHETIC_GENERATION_DENIED$/);
  assert.deepEqual(await state(),before);assert.deepEqual(await privilege(),expected);
  const verifier=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  for (const tenant of [...first.tenants,...second.tenants]) assert.equal(await verifier.verifyTenantChain(tenant.tenantId),true);
});

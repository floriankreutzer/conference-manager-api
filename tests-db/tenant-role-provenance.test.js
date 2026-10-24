import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantUserAdminRepository } from '../src/persistence/postgres/tenant-user-admin-repository.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresTenantUserLifecycleRepository } from '../src/persistence/postgres/tenant-user-lifecycle-repository.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';

test('native role provenance preserves independent grants, fences sessions and refuses destructive downgrade',async t=>{
  const pool=createPostgresPool({ mode: 'test',...loadDatabaseConfig(process.env,'test') });
  t.after(()=>pool.end());await migrateUp(pool);
  const tenantId=randomUUID(),foreign=randomUUID(),userId=randomUUID(),actor=randomUUID(),directory=randomUUID(),group=randomUUID();
  for (const id of [tenantId,foreign]) await pool.query(
    "INSERT INTO tenants(id,display_name,status) VALUES($1,'Role fixture','active')",[id]);
  for (const id of [userId,actor]) await pool.query(
    "INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Role fixture')",[tenantId,id]);
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const audit=createAuditService({ repository: auditRepository,authorizationPolicy: createAuthorizationPolicy() });
  const repo=createPostgresTenantUserAdminRepository(pool,{ auditRepository });
  const mutate=(roles,repository=repo)=>repository.setElevatedRoles({ tenantId,targetUserId: userId,elevatedRoles: roles,
    changedAt: new Date(),auditEventFor: ()=>audit.createActorEvent({ tenantId,actorUserId: actor,
      correlationId: randomUUID(),action: 'tenant.user_permissions.changed',targetType: 'user',targetId: userId,
      outcome: 'success',retentionClass: 'administrative',metadata: { operation: 'direct_role_fixture' } }) });
  await pool.query(`INSERT INTO tenant_user_roles(tenant_id,user_id,role,direct_grant,microsoft_directory_id,
    microsoft_group_ids,microsoft_verified_until)
    VALUES($1,$2,'conference_manager',false,$3,ARRAY[$4]::uuid[],clock_timestamp()+interval '1 hour')`,[tenantId,userId,directory,group]);
  const listed=(await repo.listByTenantId({ tenantId })).find(row=>row.userId===userId);
  assert.deepEqual(listed.elevatedRoles,[]);assert.deepEqual(listed.microsoftGroupRoles,['conference_manager']);
  const lifecycle=createPostgresTenantUserLifecycleRepository(pool,{ auditRepository });
  const lifecycleListed=(await lifecycle.listByTenantId({ tenantId,role: 'conference_manager' })).find(row=>row.userId===userId);
  assert.deepEqual(lifecycleListed.elevatedRoles,[]);
  assert.deepEqual(lifecycleListed.microsoftGroupRoles,['conference_manager']);
  assert.equal((await lifecycle.listByTenantId({ tenantId,role: 'employee_only' })).some(row=>row.userId===userId),false);
  const lifecycleEvent=()=>audit.createActorEvent({ tenantId,actorUserId: actor,correlationId: randomUUID(),
    action: 'tenant.user_permissions.changed',targetType: 'user',targetId: userId,outcome: 'success',
    retentionClass: 'administrative',metadata: { operation: 'lifecycle_fixture' } });
  const disabled=await lifecycle.changeAccess({ tenantId,targetUserId: userId,active: false,expectedVersion: 1,
    changedAt: new Date(),auditEventFor: lifecycleEvent });
  assert.equal(disabled.status,'updated');
  assert.deepEqual(disabled.user.elevatedRoles,[]);
  assert.deepEqual(disabled.user.microsoftGroupRoles,['conference_manager']);
  await lifecycle.changeAccess({ tenantId,targetUserId: userId,active: true,expectedVersion: 2,
    changedAt: new Date(),auditEventFor: lifecycleEvent });
  assert.equal((await mutate([])).status,'unchanged');
  await mutate(['conference_manager']);
  let stored=(await pool.query('SELECT * FROM tenant_user_roles WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId])).rows[0];
  assert.equal(stored.direct_grant,true);assert.deepEqual(stored.microsoft_group_ids,[group]);
  const failed=createPostgresTenantUserAdminRepository(pool,{ auditRepository: { async appendWithClient() { return null; } } });
  await assert.rejects(mutate([],failed),/AUDIT_APPEND_FAILED/);
  assert.equal((await pool.query('SELECT direct_grant FROM tenant_user_roles WHERE tenant_id=$1 AND user_id=$2',
    [tenantId,userId])).rows[0].direct_grant,true);
  const removed=await mutate([]);
  assert.deepEqual(removed.user.elevatedRoles,[]);assert.deepEqual(removed.user.microsoftGroupRoles,['conference_manager']);
  const sessionService=createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),
    auditService: audit,publicOrigin: 'https://customer.example.com',csrfSecret: 's'.repeat(48) });
  const version=async()=>Number((await pool.query('SELECT security_version FROM users WHERE tenant_id=$1 AND id=$2',
    [tenantId,userId])).rows[0].security_version);
  const issued=await sessionService.issue({ tenantId,userId,providerIdentity: { provider: 'microsoft_entra',reference: 'fixture-member' },
    ...tenantAuthorizationSnapshot(['employee','conference_manager']),securityVersion: await version() },{ correlationId: randomUUID() });
  const request={ headers: { cookie: issued.setCookie.split(';')[0] } };
  assert.ok(await sessionService.resolvePrincipal(request));
  const before=await version();
  await pool.query('UPDATE tenant_user_roles SET microsoft_group_ids=ARRAY[$3]::uuid[] WHERE tenant_id=$1 AND user_id=$2',
    [tenantId,userId,randomUUID()]);
  assert.equal(await version(),before+1);assert.equal(await sessionService.resolvePrincipal(request),null);
  const cross=await repo.setElevatedRoles({ tenantId: foreign,targetUserId: userId,elevatedRoles: [],changedAt: new Date(),
    auditEventFor() { throw new Error('FOREIGN_AUDIT_MUST_NOT_RUN'); } });
  assert.equal(cross.status,'not_found');
  await assert.rejects(pool.query('UPDATE tenant_user_roles SET microsoft_group_ids=ARRAY[$3,$3]::uuid[] WHERE tenant_id=$1 AND user_id=$2',
    [tenantId,userId,group]),{ code: '23514' });
  await pool.query(`INSERT INTO tenant_user_roles(tenant_id,user_id,role,direct_grant,microsoft_directory_id,
    microsoft_group_ids,microsoft_verified_until)
    VALUES($1,$2,'tenant_admin',false,$3,ARRAY[$4]::uuid[],clock_timestamp()+interval '1 hour')`,[tenantId,userId,directory,group]);
  await mutate(['tenant_admin']);
  const retainedAdmin=await mutate([]);
  assert.equal(retainedAdmin.status,'updated');
  assert.deepEqual(retainedAdmin.user.microsoftGroupRoles,['conference_manager','tenant_admin']);
  await assert.rejects(pool.query('UPDATE tenant_user_roles SET user_id=$3 WHERE tenant_id=$1 AND user_id=$2',
    [tenantId,userId,actor]),{ code: '42501' });
  await assert.rejects(rollbackLatest(pool),{ code: '55000' });
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId]);
  assert.deepEqual((await repo.listByTenantId({ tenantId })).find(row=>row.userId===userId).elevatedRoles,[]);
  assert.equal(await rollbackLatest(pool),true); // Empty069.
  assert.equal(await rollbackLatest(pool),true); // Original068 downgrade remains covered.
});

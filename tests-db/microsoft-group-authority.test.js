import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { readCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { createPostgresTenantMicrosoftRoleRepository } from '../src/persistence/postgres/tenant-microsoft-role-repository.js';
import { createPostgresTenantUserAdminRepository } from '../src/persistence/postgres/tenant-user-admin-repository.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';

const CLIENT='c8000000-0000-4000-8000-000000000001',DIRECTORY='c8000000-0000-4000-8000-000000000002';
const SUBJECT='c8000000-0000-4000-8000-000000000003',GROUP='c8000000-0000-4000-8000-000000000004';
const OTHER_GROUP='c8000000-0000-4000-8000-000000000005',AUTHORITY='https://login.microsoftonline.com/organizations';
test('native Microsoft groups require approved REAL mapping and verified flow; removal, overage and expiry revoke derived authority',
  async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const real=await createInvitedCustomerFixture(pool,t,{ recipient: 'Group-real@example.test' });
  const foreign=await createInvitedCustomerFixture(pool,t,{ recipient: 'Group-foreign@example.test' });
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const provider=microsoftCodeSdkFixture({ clientId: CLIENT,authority: AUTHORITY,tenantId: DIRECTORY,
    userId: SUBJECT,clock: ()=>Date.now() });provider.state.groups=[GROUP];
  const microsoftClient=createFreshCustomerEntraClient({ clientId: CLIENT,clientSecret: 's'.repeat(48),authority: AUTHORITY,
    publicOrigin: 'https://127.0.0.1',applicationFactory: ()=>provider.application(),includeGroupMembership: true });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',keys: new Map([['initial',Buffer.alloc(32,3)]]),
    lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const access=createProtectedInvitedCustomerAccess({ pool,leasePool,environment: 'int',securityEpoch: epoch,
    publicOrigin: 'https://127.0.0.1',cipher,auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48),
    emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),emailSourceSecret: 'b'.repeat(48),
    microsoftFlowSecret: 'm'.repeat(48),microsoftClient });
  const ms=access.microsoft,correlationId=()=>randomUUID(),userId=real.principal.userId;
  const context=principal=>({ principal,tenantContext: { tenantId: real.tenantId,status: 'onboarding' },correlationId: correlationId() });
  async function proof(principal=null) {
    const started=await ms.authenticationService[principal ? 'startLink' : 'startLogin']({ correlationId: correlationId(),
      sourceKey: randomBytes(32).toString('hex'),...(principal ? { principal } : {}) });
    assert.equal(started.status,'redirect');const url=new URL(started.authorizationUrl);
    provider.state.sentNonce=url.searchParams.get('nonce');
    const completed=await ms.authenticationService.complete({
      ...readCustomerMicrosoftTransactionCookie({ cookie: started.setCookie.split(';')[0] }),state: url.searchParams.get('state'),
      code: 'synthetic-code',providerError: null,correlationId: correlationId(),principal });
    assert.equal(completed.status,principal ? 'link_confirmation_required' : 'membership_required');
    return { ...readCustomerMicrosoftTransactionCookie({ cookie: completed.setCookie.split(';')[0] }),
      csrfToken: completed.csrfToken,correlationId: correlationId(),...(principal ? { principal } : {}) };
  }
  async function resolve(cookie) { return access.sessionService.resolvePrincipal({ headers: { cookie: cookie.split(';')[0] } }); }
  async function signIn() {
    const flow=await proof(),result=await ms.admissionService.select(flow,{ membershipId: real.membershipId });
    assert.equal(result.status,'authenticated');const principal=await resolve(result.setCookie);assert.ok(principal);
    return { cookie: result.setCookie,principal,flow };
  }
  const linked=await ms.admissionService.confirmLink(await proof(real.principal),{ confirm: true });
  assert.equal(linked.status,'authenticated');
  let signed=await signIn();
  assert.deepEqual(signed.principal.roles,['employee','tenant_admin']); // Raw group alone grants nothing.
  assert.deepEqual(await access.groupRoleService.get(context(signed.principal)),{ revision: 0,directoryId: null,mappings: [] });
  await assert.rejects(access.groupRoleService.get({ principal: foreign.principal,
    tenantContext: { tenantId: foreign.tenantId,status: 'onboarding' },correlationId: correlationId() }));
  const settings=await access.groupRoleService.replace(context(signed.principal),{ directoryId: DIRECTORY,
    mappings: [{ groupId: GROUP,roles: ['conference_manager'] }],expectedRevision: 0 });
  assert.equal(settings.revision,1);
  signed=await signIn();assert.deepEqual(signed.principal.roles,['employee','conference_manager','tenant_admin']);
  const users=createPostgresTenantUserAdminRepository(pool,{ auditRepository: real.auditRepository });
  let member=(await users.listByTenantId({ tenantId: real.tenantId })).find(user=>user.userId===userId);
  assert.deepEqual(member.elevatedRoles,['tenant_admin']);assert.deepEqual(member.microsoftGroupRoles,['conference_manager']);
  const mappingRepository=createPostgresTenantMicrosoftRoleRepository(pool,{ auditRepository: real.auditRepository });
  const failRepository=createPostgresTenantMicrosoftRoleRepository(pool,{ auditRepository: { async appendWithClient() { return null; } } });
  const auditEventFor=()=>real.auditService.createEvent({ ...context(signed.principal),action: 'tenant.configuration.changed',
    targetType: 'microsoft_role_mapping',targetId: real.tenantId,outcome: 'success',retentionClass: 'administrative' });
  await assert.rejects(failRepository.replace({ tenantId: real.tenantId,actorUserId: userId,directoryId: DIRECTORY,mappings: [],
    expectedRevision: 1,auditEventFor }),/AUDIT_FAILED/);
  assert.ok(await resolve(signed.cookie));
  assert.equal((await mappingRepository.get({ tenantId: real.tenantId })).revision,1);
  // A complete later observation removes only the revoked group's source.
  provider.state.groups=[OTHER_GROUP];const revoked=await signIn();
  assert.deepEqual(revoked.principal.roles,['employee','tenant_admin']);assert.equal(await resolve(signed.cookie),null);
  provider.state.groups=[GROUP];signed=await signIn();
  provider.state.groupOverage=true;const overage=await signIn();
  assert.deepEqual(overage.principal.roles,['employee','tenant_admin']);assert.equal(await resolve(signed.cookie),null);
  provider.state.groupOverage=false;provider.state.groups=undefined;const absent=await signIn();
  assert.deepEqual(absent.principal.roles,['employee','tenant_admin']);
  provider.state.groups=[GROUP];signed=await signIn();
  // Refreshing the cache cannot revive an older session. Deadline denial is
  // independently tested after issuing a current-version email session.
  const before=signed.cookie;signed=await signIn();assert.equal(await resolve(before),null);
  await pool.query(`UPDATE tenant_user_roles SET microsoft_verified_until=clock_timestamp()+interval '5 seconds'
    WHERE tenant_id=$1 AND user_id=$2 AND role='conference_manager'`,[real.tenantId,userId]);
  const version=Number((await pool.query('SELECT security_version FROM users WHERE tenant_id=$1 AND id=$2',
    [real.tenantId,userId])).rows[0].security_version);
  const email=await access.sessionService.issue({ tenantId: real.tenantId,userId,securityVersion: version,
    roles: signed.principal.roles,permissions: signed.principal.permissions,providerIdentity: real.principal.providerIdentity },
  { correlationId: correlationId() });
  assert.ok(await resolve(email.setCookie));
  await new Promise(resolve=>setTimeout(resolve,5200));
  assert.equal(await resolve(email.setCookie),null);
  member=(await users.listByTenantId({ tenantId: real.tenantId })).find(user=>user.userId===userId);
  assert.equal(member.microsoftGroupRoles,undefined);assert.deepEqual(member.elevatedRoles,['tenant_admin']);
  signed=await signIn();
  await access.groupRoleService.replace(context(signed.principal),{ directoryId: DIRECTORY,
    mappings: [{ groupId: GROUP,roles: ['tenant_admin'] }],expectedRevision: 1 });
  signed=await signIn();
  const recoveryAdmin=(await pool.query('SELECT id FROM users WHERE tenant_id=$1 AND id<>$2',
    [real.tenantId,userId])).rows[0].id;
  const direct=(targetUserId,elevatedRoles,actorUserId)=>users.setElevatedRoles({ tenantId: real.tenantId,
    targetUserId,elevatedRoles,changedAt: new Date(),auditEventFor: ()=>real.auditService.createActorEvent({
      tenantId: real.tenantId,actorUserId,correlationId: correlationId(),action: 'tenant.user_permissions.changed',
      targetType: 'user',targetId: targetUserId,outcome: 'success',retentionClass: 'administrative',
      metadata: { operation: 'native_direct_role_fixture' } }) });
  await direct(userId,[],recoveryAdmin);signed=await signIn();
  assert.deepEqual(signed.principal.roles,['employee','tenant_admin']); // Group-only Admin is effective.
  await direct(recoveryAdmin,[],userId);
  await assert.rejects(access.groupRoleService.replace(context(signed.principal),{
    directoryId: DIRECTORY,mappings: [],expectedRevision: 2 }),{ code: 'MICROSOFT_ROLE_DIRECT_ADMIN_REQUIRED' });
  assert.equal((await mappingRepository.get({ tenantId: real.tenantId })).revision,2);
  await direct(recoveryAdmin,['tenant_admin'],userId);
  const reset=await access.groupRoleService.replace(context(signed.principal),{
    directoryId: DIRECTORY,mappings: [],expectedRevision: 2 });
  assert.equal(reset.revision,3);assert.equal(await resolve(signed.cookie),null);
  signed=await signIn();assert.deepEqual(signed.principal.roles,['employee']);
  assert.equal(await real.auditRepository.verifyTenantChain(real.tenantId),true);
  await assert.rejects(rollbackLatest(pool),{ code: '55000' }); // Preserve mappings, observations and approval evidence.
});

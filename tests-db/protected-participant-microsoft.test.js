import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { readCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';

// The Microsoft SDK is an in-process protocol fixture. It proves no operating
// Microsoft tenant acceptance and never sends an authentication/provider request.
test('restricted participant Microsoft link and primary login preserve exact three-slot membership custody',async t=>{
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
  const customerUrl=new URL(fixture.url);customerUrl.username='cm_protected_int_customer';
  const customerPool=database(customerUrl.href),customerLease=database(customerUrl.href);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: customerPool,leasePool: customerLease,
    environment: 'int',securityEpoch: epoch });
  const owner=await createProtectedSyntheticMicrosoftFixture(pool,lease,{ epoch }),generationId=randomUUID(),customers=[];
  await pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
    VALUES('int',$1,$2,1,$3)`,[generationId,owner.operatorId,epoch]);
  const tenants=['northwind','contoso','fabrikam'].map(slot=>({ slot,tenantId: randomUUID() }));
  for (const { slot,tenantId } of tenants) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,$2,'onboarding')",[tenantId,slot]);
    await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
      VALUES('int',$1,'synthetic',$2,$3,$4)`,[tenantId,generationId,owner.operatorId,slot]);
  }
  await pool.query("UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp() WHERE id=$1",
    [generationId]);
  for (const { slot,tenantId } of tenants) {
    customers.push(await createInvitedCustomerFixture(pool,t,{ recipient: `${slot}@example.test`,targetTenantId: tenantId,
      async beforeAdmission({ invitation }) {
        // Storage fixture registration precedes actual mailbox admission; the
        // separate participant progression covers protected Platform issuance.
        await pool.query(`INSERT INTO synthetic_invited_memberships
          (environment,tenant_id,membership_id,invitation_id,generation_id,operator_id,slot)
          SELECT 'int',$1,membership_id,id,$3,$4,$5 FROM customer_member_invitations
          WHERE environment='int' AND tenant_id=$1 AND id=$2`,[tenantId,invitation.id,generationId,owner.operatorId,slot]);
      } }));
  }
  const clientId=randomUUID(),directory=randomUUID(),subject=randomUUID(),authority='https://login.microsoftonline.com/organizations';
  const provider=microsoftCodeSdkFixture({ clientId,authority,tenantId: directory,userId: subject,clock: ()=>Date.now() });
  const microsoftClient=createFreshCustomerEntraClient({ clientId,clientSecret: 's'.repeat(48),authority,
    publicOrigin: 'https://127.0.0.1',applicationFactory: ()=>provider.application() });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',keys: new Map([['initial',Buffer.alloc(32,3)]]),
    lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const options={ pool: customerPool,leasePool: customerLease,environment: 'int',securityEpoch: epoch,
    publicOrigin: 'https://127.0.0.1',cipher,auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48),
    emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),emailSourceSecret: 'b'.repeat(48),
    microsoftFlowSecret: 'm'.repeat(48),microsoftClient };
  const access=createProtectedInvitedCustomerAccess({ ...options,syntheticParticipantsEnabled: true });
  const strict=createProtectedInvitedCustomerAccess(options),ms=access.microsoft,sourceKey=ms.sourceKey.fingerprint('127.0.0.1');
  async function start(principal=null) {
    const result=await ms.authenticationService[principal ? 'startLink' : 'startLogin']({ correlationId: randomUUID(),sourceKey,
      ...(principal ? { principal } : {}) });assert.equal(result.status,'redirect');
    return { result,principal,url: new URL(result.authorizationUrl) };
  }
  async function complete(started) {
    provider.state.sentNonce=started.url.searchParams.get('nonce');
    const transaction=readCustomerMicrosoftTransactionCookie({ cookie: started.result.setCookie.split(';')[0] });
    return ms.authenticationService.complete({ ...transaction,
      state: started.url.searchParams.get('state'),code: 'synthetic-code',providerError: null,
      correlationId: randomUUID(),principal: started.principal });
  }
  const proof=(result,principal)=>({ ...readCustomerMicrosoftTransactionCookie({ cookie: result.setCookie.split(';')[0] }),
    csrfToken: result.csrfToken,correlationId: randomUUID(),...(principal ? { principal } : {}) });
  const evidence=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM sessions) AS sessions,(SELECT count(*)::int FROM audit_events) AS audits,
    (SELECT count(*)::int FROM user_identity_bindings WHERE provider='microsoft_entra') AS bindings`)).rows[0];
  const linkedSessions=[];
  // An unlinked primary identity cannot create/link a membership from email claims.
  const beforeUnknown=await evidence();
  const unknown=await complete(await start());assert.equal(unknown.status,'membership_required');
  const unknownProof=proof(unknown);
  const unknownChoices=await ms.admissionService.choices({ flowId: unknownProof.flowId,browserToken: unknownProof.browserToken });
  assert.equal(unknownChoices.status,'rejected');
  assert.equal((await evidence()).bindings,0);
  assert.deepEqual(await evidence(),beforeUnknown);
  for (const customer of customers) {
    const identity={ tenantId: customer.tenantId,userId: customer.principal.userId,
      securityVersion: customer.principal.session.securityVersion,
      roles: customer.principal.roles,permissions: customer.principal.permissions,providerIdentity: customer.principal.providerIdentity };
    const emailSession=await scopes.withShared(()=>access.sessionService.issue(identity,{ correlationId: randomUUID() }));
    const emailCookie=emailSession.setCookie.split(';')[0];
    const principal=await scopes.withShared(()=>access.sessionService.resolvePrincipal({ headers: { cookie: emailCookie } }));
    assert.ok(principal);assert.equal(principal.providerIdentity.provider,'email_code');
    const denied=await strict.microsoft.authenticationService.startLink({ correlationId: randomUUID(),sourceKey,principal });
    assert.equal(denied.status,'rejected');
    assert.deepEqual(await ms.admissionService.accountState({ principal }),
      { status: 'account',microsoftLinked: false,emailReauthenticationRequired: false });
    const result=await complete(await start(principal));assert.equal(result.status,'link_confirmation_required');
    const input=proof(result,principal),before=await evidence();
    assert.equal((await ms.admissionService.confirmLink({ ...input,csrfToken: '0'.repeat(64) },{ confirm: true })).status,'rejected');
    assert.deepEqual(await evidence(),before);
    const linked=await ms.admissionService.confirmLink(input,{ confirm: true });assert.equal(linked.status,'authenticated');
    assert.equal((await ms.admissionService.confirmLink(input,{ confirm: true })).status,'rejected');
    assert.equal(await scopes.withShared(()=>access.sessionService.resolvePrincipal({ headers: { cookie: emailCookie } })),null);
    const cookie=linked.setCookie.split(';')[0];
    const current=await scopes.withShared(()=>access.sessionService.resolvePrincipal({ headers: { cookie } }));
    assert.equal(current.userId,customer.principal.userId);assert.equal(current.tenantId,customer.tenantId);
    assert.equal(current.providerIdentity.provider,'microsoft_entra');assert.deepEqual(current.roles,principal.roles);
    assert.equal(await scopes.withShared(()=>strict.sessionService.resolvePrincipal({ headers: { cookie } })),null);
    linkedSessions.push({ cookie,principal: current });
  }
  const verified=await complete(await start());assert.equal(verified.status,'membership_required');
  const login=proof(verified),choices=await ms.admissionService.choices({ flowId: login.flowId,browserToken: login.browserToken });
  assert.deepEqual(choices.items.map(row=>row.membershipId).sort(),customers.map(row=>row.membershipId).sort());
  const beforeForeign=await evidence();
  assert.equal((await ms.admissionService.select(login,{ membershipId: randomUUID() })).status,'rejected');
  assert.deepEqual(await evidence(),beforeForeign);
  const selected=await Promise.all([1,2].map(()=>ms.admissionService.select(login,{ membershipId: customers[0].membershipId })));
  assert.deepEqual(selected.map(value=>value.status).sort(),['authenticated','rejected']);
  const pending=await start(),captured=proof(await complete(await start()));
  const currentChoices=await ms.admissionService.choices({ flowId: captured.flowId,browserToken: captured.browserToken });
  assert.equal(currentChoices.status,'membership_required');assert.equal(currentChoices.items.length,3);
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[owner.operatorId]);
  for (const row of linkedSessions) {
    assert.equal(await scopes.withShared(()=>access.sessionService.resolvePrincipal({ headers: { cookie: row.cookie } })),null);
    assert.equal((await ms.admissionService.accountState({ principal: row.principal })).status,'rejected');
  }
  const disabledChoices=await ms.admissionService.choices({ flowId: captured.flowId,browserToken: captured.browserToken });
  assert.equal(disabledChoices.status,'membership_required');assert.deepEqual(disabledChoices.items,[]);
  const retained=await evidence();
  const result=await complete(pending);assert.equal(result.status,'membership_required');
  const disabledProof=proof(result);
  const noChoices=await ms.admissionService.choices({ flowId: disabledProof.flowId,browserToken: disabledProof.browserToken });
  assert.equal(noChoices.status,'rejected');
  assert.deepEqual(await evidence(),retained);
  for (const customer of customers) assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_passkey_credentials')).rows[0].n,0);
});

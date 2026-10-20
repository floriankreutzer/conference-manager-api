import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresCustomerMicrosoftFlowRepository } from '../src/persistence/postgres/customer-microsoft-flow-repository.js';
import { createCustomerMicrosoftAuthenticationService } from '../src/identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftAdmissionService } from '../src/identity/customer-microsoft-admission-service.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { readCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
const CLIENT='b6000000-0000-4000-8000-000000000001',DIRECTORY='b6000000-0000-4000-8000-000000000002';
const SUBJECT='b6000000-0000-4000-8000-000000000003',AUTHORITY='https://login.microsoftonline.com/organizations';

test('explicit dual-proof linking and invited Microsoft admission are atomic, single-use and current-authority scoped',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const customer=await createInvitedCustomerFixture(pool,t);
  const binding=createCustomerMicrosoftFlowBinding({ secret: 'm'.repeat(48),environment: 'int' });t.after(()=>binding.destroy());
  const repository=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment: 'int',flowBinding: binding,
    auditRepository: customer.auditRepository });
  const provider=microsoftCodeSdkFixture({ clientId: CLIENT,authority: AUTHORITY,tenantId: DIRECTORY,
    userId: SUBJECT,clock: ()=>Date.now() });
  const authentication=createCustomerMicrosoftAuthenticationService({ repository,flowBinding: binding,entraClient:
    createFreshCustomerEntraClient({ clientId: CLIENT,clientSecret: 's'.repeat(48),authority: AUTHORITY,
      publicOrigin: 'https://127.0.0.1',applicationFactory: ()=>provider.application() }) });
  const admission=(sessionService=customer.sessions,auditService=customer.auditService)=>createCustomerMicrosoftAdmissionService({
    repository,auditService,sessionService });
  async function primary(link=false) {
    const principal=link ? customer.principal : null,correlationId=randomUUID();
    const result=await authentication[link ? 'startLink' : 'startLogin']({ correlationId,sourceKey: randomUUID().replaceAll('-','')
      .repeat(2),...(link ? { principal } : {}) });assert.equal(result.status,'redirect');
    const url=new URL(result.authorizationUrl);provider.state.sentNonce=url.searchParams.get('nonce');
    const input=readCustomerMicrosoftTransactionCookie({ cookie: result.setCookie.split(';')[0] });
    const verified=await authentication.complete({ ...input,state: url.searchParams.get('state'),code: 'synthetic-code',
      providerError: null,correlationId: randomUUID(),principal });
    assert.equal(verified.status,link ? 'link_confirmation_required' : 'membership_required');
    return { ...readCustomerMicrosoftTransactionCookie({ cookie: verified.setCookie.split(';')[0] }),
      csrfToken: verified.csrfToken,correlationId: randomUUID(),...(link ? { principal } : {}) };
  }
  async function evidence() {
    const result=await pool.query(`SELECT (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(*)::int FROM user_identity_bindings WHERE provider='microsoft_entra') AS bindings,
      (SELECT count(*)::int FROM audit_events WHERE action='tenant.user.identity_linked') AS links,
      (SELECT security_version::int FROM users WHERE tenant_id=$1 AND id=$2) AS version`,
    [customer.tenantId,customer.principal.userId]);return result.rows[0];
  }
  const link=await primary(true),before=await evidence();
  await t.test('confirmation reads and invalid browser/CSRF/foreign principal cannot mutate identity or session authority',async()=>{
    assert.equal((await admission().linkConfirmation({ flowId: link.flowId,browserToken: link.browserToken,
      principal: customer.principal })).status,'link_confirmation_required');
    for (const input of [{ ...link,csrfToken: '0'.repeat(64) },{ ...link,browserToken: 'W'.repeat(43) },
      { ...link,principal: { ...customer.principal,tenantId: randomUUID() } }]) {
      assert.equal((await admission().confirmLink(input,{ confirm: true })).status,'rejected');
    }
    assert.deepEqual(await evidence(),before);
  });
  await t.test('session/audit failures roll back binding, security version, flow consumption and all audit changes',async()=>{
    const failing=admission({ async issue() { throw new Error('SYNTHETIC_SESSION_FAILURE'); } });
    await assert.rejects(failing.confirmLink(link,{ confirm: true }),/SYNTHETIC_SESSION_FAILURE/);
    assert.deepEqual(await evidence(),before);
    const invalidAudit=admission(customer.sessions,{ createActorEvent() { throw new Error('SYNTHETIC_AUDIT_FAILURE'); } });
    await assert.rejects(invalidAudit.confirmLink(link,{ confirm: true }),/SYNTHETIC_AUDIT_FAILURE/);
    assert.deepEqual(await evidence(),before);
    assert.equal((await pool.query('SELECT status FROM customer_microsoft_flows WHERE id=$1',[link.flowId])).rows[0].status,'verified');
  });
  await t.test('concurrent explicit confirmations commit one exact identity/audit/session and invalidate older sessions',async()=>{
    const result=await Promise.all([admission().confirmLink(link,{ confirm: true }),admission().confirmLink(link,{ confirm: true })]);
    assert.deepEqual(result.map(value=>value.status).sort(),['authenticated','rejected']);
    const accepted=result.find(value=>value.status==='authenticated');
    const principal=await customer.sessions.resolvePrincipal({ headers: { cookie: accepted.setCookie.split(';')[0] } });
    assert.equal(principal.tenantId,customer.tenantId);assert.equal(principal.userId,customer.principal.userId);
    assert.deepEqual(principal.roles,['employee','tenant_admin']);assert.equal(principal.session.securityVersion,before.version+1);
    assert.equal(principal.providerIdentity.provider,'microsoft_entra');
    assert.equal(await customer.sessions.resolvePrincipal({ headers: { cookie: customer.cookie } }),null);
    assert.deepEqual(await evidence(),{ sessions: before.sessions+1,bindings: before.bindings+1,links: before.links+1,
      version: before.version+1 });
    assert.equal((await admission().confirmLink(link,{ confirm: true })).status,'rejected');
    assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
  });
  await t.test('Microsoft login offers only the linked accepted membership and requires explicit current selection',async()=>{
    const input=await primary(),counts=await evidence();
    const choices=await admission().choices({ flowId: input.flowId,browserToken: input.browserToken });
    assert.equal(choices.status,'membership_required');assert.deepEqual(choices.items,[{ membershipId: customer.membershipId,
      displayName: 'Synthetic invited customer' }]);assert.equal(choices.csrfToken,input.csrfToken);
    assert.doesNotMatch(JSON.stringify(choices),/tenantId|userId|roles|permissions|email|provider/);
    assert.equal((await admission().select(input,{ membershipId: randomUUID() })).status,'rejected');
    assert.equal((await admission().select({ ...input,csrfToken: '0'.repeat(64) },
      { membershipId: customer.membershipId })).status,'rejected');
    assert.deepEqual(await evidence(),counts);
    const outcomes=await Promise.all([1,2].map(()=>admission().select(input,{ membershipId: customer.membershipId })));
    assert.deepEqual(outcomes.map(value=>value.status).sort(),['authenticated','rejected']);
    const issued=outcomes.find(value=>value.status==='authenticated');
    const principal=await customer.sessions.resolvePrincipal({ headers: { cookie: issued.setCookie.split(';')[0] } });
    assert.equal(principal.userId,customer.principal.userId);assert.equal(principal.tenantId,customer.tenantId);
    assert.deepEqual(principal.roles,['employee','tenant_admin']);
    assert.equal((await admission().choices({ flowId: input.flowId,browserToken: input.browserToken })).status,'rejected');
    assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
  });
  await t.test('a later authoritative User/security-version change invalidates the captured login choice',async()=>{
    const input=await primary(),counts=await evidence();
    // Fixture-only authority change; the admission assertion retains the exact
    // same captured proof and must not silently refresh it into a newer version.
    await pool.query('UPDATE users SET security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',
      [customer.tenantId,customer.principal.userId]);
    assert.equal((await admission().select(input,{ membershipId: customer.membershipId })).status,'rejected');
    assert.equal((await evidence()).sessions,counts.sessions);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresCustomerMicrosoftFlowRepository } from '../src/persistence/postgres/customer-microsoft-flow-repository.js';
import { createCustomerMicrosoftAuthenticationService } from '../src/identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { readCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
const CLIENT='b4000000-0000-4000-8000-000000000001',DIRECTORY='b4000000-0000-4000-8000-000000000002';
const SUBJECT='b4000000-0000-4000-8000-000000000003',AUTHORITY='https://login.microsoftonline.com/organizations';

test('durable invited Microsoft primary flow preserves browser/state custody before explicit selection or link confirmation',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  await t.test('empty Microsoft migration rolls back without rewriting accepted057 and restores its exact checksum',async()=>{
    const checksum=(await pool.query('SELECT checksum FROM schema_migrations WHERE version=58')).rows[0].checksum;
    const accepted=(await pool.query('SELECT checksum FROM schema_migrations WHERE version=57')).rows[0].checksum;
    assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
    assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before the original Microsoft058 probe.
    assert.equal(await rollbackLatest(pool),true);
    assert.equal(Number((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version),57);
    await migrateUp(pool);
    assert.equal(Number((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version),60);
    assert.equal((await pool.query('SELECT checksum FROM schema_migrations WHERE version=58')).rows[0].checksum,checksum);
    assert.equal((await pool.query('SELECT checksum FROM schema_migrations WHERE version=57')).rows[0].checksum,accepted);
  });
  await t.test('private identity constraint has a fixed read-only definer context and no PUBLIC execution grant',async()=>{
    const result=await pool.query(`SELECT procedure.prosecdef,procedure.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(procedure.proacl,acldefault('f',procedure.proowner))) privilege
        WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc procedure WHERE procedure.oid='public.guard_customer_microsoft_identity_link()'::regprocedure`);
    assert.equal(result.rowCount,1);assert.equal(result.rows[0].prosecdef,true);
    assert.deepEqual(result.rows[0].proconfig,['search_path=pg_catalog']);assert.equal(result.rows[0].public_execute,false);
  });
  const customer=await createInvitedCustomerFixture(pool,t);
  const binding=createCustomerMicrosoftFlowBinding({ secret: 'm'.repeat(48),environment: 'int' });t.after(()=>binding.destroy());
  const repository=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment: 'int',flowBinding: binding });
  const provider=microsoftCodeSdkFixture({ clientId: CLIENT,authority: AUTHORITY,tenantId: DIRECTORY,
    userId: SUBJECT,clock: ()=>Date.now() });
  function service() {
    const client=createFreshCustomerEntraClient({ clientId: CLIENT,clientSecret: 's'.repeat(48),authority: AUTHORITY,
      publicOrigin: 'https://127.0.0.1',applicationFactory: ()=>provider.application() });
    return createCustomerMicrosoftAuthenticationService({ repository,entraClient: client,flowBinding: binding });
  }
  const counts=async()=>{
    const result=await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(*)::int FROM user_identity_bindings WHERE provider='microsoft_entra') AS microsoft`);return result.rows[0];
  };
  async function start(link=false,sourceKey='a'.repeat(64)) {
    const input={ correlationId: randomUUID(),sourceKey,...(link ? { principal: customer.principal } : {}) };
    const result=await service()[link ? 'startLink' : 'startLogin'](input);assert.equal(result.status,'redirect');
    const url=new URL(result.authorizationUrl);provider.state.sentNonce=url.searchParams.get('nonce');
    return { ...readCustomerMicrosoftTransactionCookie({ cookie: result.setCookie.split(';')[0] }),
      state: url.searchParams.get('state'),code: 'synthetic-code',providerError: null,correlationId: randomUUID(),
      principal: link ? customer.principal : null };
  }
  const baseline=await counts();
  await t.test('wrong browser/state cannot exchange; concurrent correct callbacks exchange exactly once across service instances',async()=>{
    const input=await start(),before=provider.state.tokenRequests;
    assert.equal((await service().complete({ ...input,browserToken: 'W'.repeat(43) })).status,'rejected');
    assert.equal((await service().complete({ ...input,state: 'W'.repeat(43) })).status,'rejected');
    assert.equal(provider.state.tokenRequests,before);
    const outcomes=await Promise.all([service().complete(input),service().complete(input)]);
    assert.deepEqual(outcomes.map(row=>row.status).sort(),['membership_required','rejected']);
    assert.equal(provider.state.tokenRequests,before+1);assert.deepEqual(await counts(),baseline);
    const row=(await pool.query('SELECT * FROM customer_microsoft_flows WHERE environment=$1 AND id=$2',['int',input.flowId])).rows[0];
    assert.equal(row.status,'verified');assert.deepEqual(row.admission_snapshot,[]);
    for (const secret of [input.state,input.browserToken,provider.state.sentNonce,input.code]) {
      assert.equal(JSON.stringify(row).includes(secret),false,'raw protocol/cookie/code is never stored');
    }
    await assert.rejects(pool.query("UPDATE customer_microsoft_flows SET status='started' WHERE environment='int' AND id=$1",
      [input.flowId]),
      error=>error.code==='23514');
  });
  await t.test('fresh admitted email plus fresh Microsoft yields only an explicit, browser-rotated link confirmation',async()=>{
    const input=await start(true),result=await service().complete(input);assert.equal(result.status,'link_confirmation_required');
    const cookie=readCustomerMicrosoftTransactionCookie({ cookie: result.setCookie.split(';')[0] });
    assert.notEqual(cookie.browserToken,input.browserToken);assert.deepEqual(await counts(),baseline);
    const row=(await pool.query('SELECT * FROM customer_microsoft_flows WHERE environment=$1 AND id=$2',['int',input.flowId])).rows[0];
    assert.equal(row.expected_user_id,customer.principal.userId);assert.equal(row.expected_session_id,customer.principal.session.id);
    assert.equal(binding.verifyCsrf({ context: { flowId: input.flowId,purpose: 'link',stage: 'confirmation' },
      browserVerifier: row.choice_verifier,csrfToken: result.csrfToken }),true);
    await assert.rejects(pool.query(`INSERT INTO user_identity_bindings
      (tenant_id,provider,provider_tenant_reference,provider_user_reference,user_id)
      VALUES($1,'microsoft_entra',$2,$3,$4)`,[customer.tenantId,DIRECTORY,SUBJECT,customer.principal.userId]),
    error=>error.code==='23514' && error.message.includes('CUSTOMER_MICROSOFT_EXPLICIT_LINK_REQUIRED'));
    assert.deepEqual(await counts(),baseline);
  });
  await t.test('source budgets survive cookie replacement and neither a new flow nor another environment bypasses custody',async()=>{
    const sourceKey='c'.repeat(64);
    for (let i=0;i<5;i++) await start(false,sourceKey);
    assert.equal((await service().startLogin({ correlationId: randomUUID(),sourceKey })).status,'rejected');
    const prodBinding=createCustomerMicrosoftFlowBinding({ secret: 'm'.repeat(48),environment: 'prod' });
    t.after(()=>prodBinding.destroy());
    const another=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment: 'prod',flowBinding: prodBinding });
    const input=await start(false,'d'.repeat(64));
    assert.equal(await another.reserve({ ...input,stateHash: binding.protocol({ state: input.state,purpose: 'login' }).stateHash }),null);
    assert.deepEqual(await counts(),baseline);
  });
  await t.test('actual email-session revocation prevents code exchange and later link starts',async()=>{
    const input=await start(true,'e'.repeat(64)),before=provider.state.tokenRequests;
    await customer.sessions.revoke(customer.principal,{ correlationId: randomUUID() });
    assert.equal((await service().complete(input)).status,'rejected');assert.equal(provider.state.tokenRequests,before);
    assert.equal((await service().startLink({ correlationId: randomUUID(),sourceKey: 'f'.repeat(64),
      principal: customer.principal })).status,'rejected');
    assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
  });
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059; retain the populated058 recovery guard.
  await assert.rejects(rollbackLatest(pool),error=>error.code==='55000'
    && error.message.includes('CUSTOMER_MICROSOFT_FLOWS_REQUIRE_VERIFIED_RECOVERY'));
});

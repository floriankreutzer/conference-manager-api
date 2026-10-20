import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { createCustomerMicrosoftAuthenticationService } from '../src/identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftAdmissionService } from '../src/identity/customer-microsoft-admission-service.js';
import { createPostgresCustomerMicrosoftFlowRepository } from '../src/persistence/postgres/customer-microsoft-flow-repository.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { readCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';
const CLIENT='b8000000-0000-4000-8000-000000000001',DIRECTORY='b8000000-0000-4000-8000-000000000002';
const SUBJECT='b8000000-0000-4000-8000-000000000003',AUTHORITY='https://login.microsoftonline.com/organizations';

test('native protected Microsoft custody requires REAL bindings, explicit dual-fresh linking and the current epoch',
  async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const real=await createInvitedCustomerFixture(pool,t,{ recipient: 'Real@example.test' });
  const unclassified=await createInvitedCustomerFixture(pool,t,{ recipient: 'Unclassified@example.test' });
  const synthetic=await createInvitedCustomerFixture(pool,t,{ recipient: 'Synthetic@example.test' });
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const operatorId=randomUUID(),generationId=randomUUID();
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles)
    VALUES($1::uuid,$2,'synthetic-directory',$1::text,ARRAY['platform_tenant_operator'])`,[operatorId,PLATFORM_ENTRA_PROVIDER]);
  await pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
    VALUES('int',$1,$2,1,$3)`,[generationId,operatorId,epoch]);
  for (const [index,slot] of ['northwind','contoso','fabrikam'].entries()) {
    const tenantId=index===0 ? synthetic.tenantId : randomUUID();
    if (index!==0) await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic slot','onboarding')",[tenantId]);
    await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
      VALUES('int',$1,'synthetic',$2,$3,$4)`,[tenantId,generationId,operatorId,slot]);
  }
  await pool.query("UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp() WHERE id=$1",
    [generationId]);
  const provider=microsoftCodeSdkFixture({ clientId: CLIENT,authority: AUTHORITY,tenantId: DIRECTORY,
    userId: SUBJECT,clock: ()=>Date.now() });
  const microsoftClient=createFreshCustomerEntraClient({ clientId: CLIENT,clientSecret: 's'.repeat(48),authority: AUTHORITY,
    publicOrigin: 'https://127.0.0.1',applicationFactory: ()=>provider.application() });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',keys: new Map([['initial',Buffer.alloc(32,3)]]),
    lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const configuration={ pool,leasePool,environment: 'int',securityEpoch: epoch,publicOrigin: 'https://127.0.0.1',cipher,
    auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48),emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),
    emailSourceSecret: 'b'.repeat(48),microsoftFlowSecret: 'm'.repeat(48),microsoftClient };
  const access=createProtectedInvitedCustomerAccess(configuration),ms=access.microsoft;
  const sourceKey=ms.sourceKey.fingerprint('127.0.0.1');
  const ordinaryBinding=createCustomerMicrosoftFlowBinding({ environment: 'int',secret: 'o'.repeat(48) });
  t.after(()=>ordinaryBinding.destroy());
  const ordinaryRepository=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment: 'int',flowBinding: ordinaryBinding,
    auditRepository: real.auditRepository });
  const ordinaryAuth=createCustomerMicrosoftAuthenticationService({ repository: ordinaryRepository,flowBinding: ordinaryBinding,
    entraClient: microsoftClient });
  const ordinaryAdmission=customer=>createCustomerMicrosoftAdmissionService({ repository: ordinaryRepository,
    auditService: customer.auditService,sessionService: customer.sessions });
  async function start(authentication,principal=null,key=sourceKey) {
    const result=await authentication[principal ? 'startLink' : 'startLogin']({ correlationId: randomUUID(),sourceKey: key,
      ...(principal ? { principal } : {}) });
    assert.equal(result.status,'redirect');
    return { result,principal,url: new URL(result.authorizationUrl) };
  }
  async function complete(authentication,started) {
    provider.state.sentNonce=started.url.searchParams.get('nonce');
    return authentication.complete({ ...readCustomerMicrosoftTransactionCookie({ cookie: started.result.setCookie.split(';')[0] }),
      state: started.url.searchParams.get('state'),code: 'synthetic-code',providerError: null,
      correlationId: randomUUID(),principal: started.principal });
  }
  const proof=(result,principal)=>({ ...readCustomerMicrosoftTransactionCookie({ cookie: result.setCookie.split(';')[0] }),
    csrfToken: result.csrfToken,correlationId: randomUUID(),...(principal ? { principal } : {}) });
  const evidence=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM sessions) AS sessions,(SELECT count(*)::int FROM audit_events) AS audits,
    (SELECT count(*)::int FROM user_identity_bindings WHERE provider='microsoft_entra') AS bindings`)).rows[0];
  const beforeDenied=await evidence();
  for (const denied of [unclassified,synthetic]) {
    assert.equal((await ms.authenticationService.startLink({ correlationId: randomUUID(),sourceKey,
      principal: denied.principal })).status,'rejected');
    assert.equal((await ms.admissionService.accountState({ principal: denied.principal })).status,'rejected');
  }
  assert.deepEqual(await evidence(),beforeDenied);
  // Deliberate isolated ordinary fixtures establish valid existing bindings for
  // both denied modes through real dual-proof custody, never direct SQL grants.
  for (const customer of [unclassified,synthetic]) {
    const result=await complete(ordinaryAuth,await start(ordinaryAuth,customer.principal,'c'.repeat(64)));
    assert.equal(result.status,'link_confirmation_required');
    assert.equal((await ordinaryAdmission(customer).confirmLink(proof(result,customer.principal),{ confirm: true })).status,
      'authenticated');
  }
  const identity={ tenantId: real.tenantId,userId: real.principal.userId,securityVersion: real.principal.session.securityVersion,
    roles: real.principal.roles,permissions: real.principal.permissions,providerIdentity: real.principal.providerIdentity };
  const fresh=await access.sessionService.issue(identity,{ correlationId: randomUUID() });
  const emailPrincipal=await access.sessionService.resolvePrincipal({ headers: { cookie: fresh.setCookie.split(';')[0] } });
  assert.ok(emailPrincipal);assert.equal(emailPrincipal.providerIdentity.provider,'email_code');
  const linkResult=await complete(ms.authenticationService,await start(ms.authenticationService,emailPrincipal));
  assert.equal(linkResult.status,'link_confirmation_required');
  const link=proof(linkResult,emailPrincipal),beforeLink=await evidence();
  assert.equal((await ms.admissionService.confirmLink({ ...link,csrfToken: '0'.repeat(64) },{ confirm: true })).status,'rejected');
  assert.deepEqual(await evidence(),beforeLink);
  const linked=await ms.admissionService.confirmLink(link,{ confirm: true });assert.equal(linked.status,'authenticated');
  assert.equal(await access.sessionService.resolvePrincipal({ headers: { cookie: fresh.setCookie.split(';')[0] } }),null);
  const microsoftPrincipal=await access.sessionService.resolvePrincipal({ headers: { cookie: linked.setCookie.split(';')[0] } });
  assert.equal(microsoftPrincipal.userId,emailPrincipal.userId);
  assert.equal(microsoftPrincipal.providerIdentity.provider,'microsoft_entra');
  const result=await complete(ms.authenticationService,await start(ms.authenticationService));
  const login=proof(result),choice=await ms.admissionService.choices({ flowId: login.flowId,browserToken: login.browserToken });
  assert.deepEqual(choice.items,[{ membershipId: real.membershipId,displayName: 'Synthetic invited customer' }]);
  const captured=(await pool.query('SELECT admission_snapshot FROM customer_microsoft_flows WHERE id=$1',[login.flowId])).rows[0];
  assert.equal(captured.admission_snapshot.length,1);assert.equal(captured.admission_snapshot[0].tenantId,real.tenantId);
  assert.equal((await ms.admissionService.select(login,{ membershipId: unclassified.membershipId })).status,'rejected');
  const accepted=await Promise.all([1,2].map(()=>ms.admissionService.select(login,{ membershipId: real.membershipId })));
  assert.deepEqual(accepted.map(value=>value.status).sort(),['authenticated','rejected']);
  const pending=await start(ms.authenticationService),verifiedResult=await complete(ms.authenticationService,
    await start(ms.authenticationService)),verified=proof(verifiedResult);
  const retained=await evidence(),nextEpoch=randomUUID();
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[nextEpoch]);
  const next=createProtectedInvitedCustomerAccess({ ...configuration,securityEpoch: nextEpoch });
  assert.equal((await complete(next.microsoft.authenticationService,pending)).status,'rejected');
  assert.equal((await next.microsoft.admissionService.choices({ flowId: verified.flowId,browserToken: verified.browserToken })).status,
    'rejected');
  assert.equal(await next.sessionService.resolvePrincipal({ headers: { cookie: linked.setCookie.split(';')[0] } }),null);
  assert.deepEqual(await evidence(),retained);
  for (const customer of [real,unclassified,synthetic]) {
    assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
  }
});

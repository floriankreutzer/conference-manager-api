import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresProtectedInvitedSessionRepository } from '../src/persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from '../src/persistence/postgres/protected-customer-access-repository.js';
import { createProtectedInvitedCustomerSessions } from '../src/identity/protected-invited-customer-sessions.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { createPostgresCustomerMicrosoftFlowRepository } from '../src/persistence/postgres/customer-microsoft-flow-repository.js';
import { createCustomerMicrosoftAuthenticationService } from '../src/identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftAdmissionService } from '../src/identity/customer-microsoft-admission-service.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { readCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

test('protected invited sessions deny legacy, foreign deployment and old epoch cookies through current PostgreSQL custody',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const customer=await createInvitedCustomerFixture(pool,t),epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const access=createPostgresProtectedCustomerAccessRepository(pool,{ environment: 'int',securityEpoch: epoch });
  const factory=(environment,securityEpoch)=>createProtectedInvitedCustomerSessions({ environment,securityEpoch,
    sessionRepository: createPostgresProtectedInvitedSessionRepository(pool,{ environment,securityEpoch,
      auditRepository: customer.auditRepository }),
    accessRepository: createPostgresProtectedCustomerAccessRepository(pool,{ environment,securityEpoch }),
    auditService: customer.auditService,publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48) });
  const sessions=factory('int',epoch),old={ headers: { cookie: customer.cookie } };
  assert.equal(await sessions.resolvePrincipal(old),null);
  let identity={ ...customer.principal,securityVersion: customer.principal.session.securityVersion };
  const counts=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM sessions) AS sessions,
    (SELECT count(*)::int FROM audit_events) AS audit`)).rows[0];
  const before=await counts();
  await assert.rejects(sessions.issue(identity,{ correlationId: randomUUID() }),/IDENTITY_NOT_PROVISIONED/);
  assert.deepEqual(await counts(),before); // Unknown classification cannot leave a latent cookie/session/audit grant.
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[customer.tenantId]);
  const issued=await sessions.issue(identity,{ correlationId: randomUUID() });
  let request={ headers: { cookie: issued.setCookie.split(';')[0] } };
  let principal=await sessions.resolvePrincipal(request);assert.ok(principal);
  assert.equal(principal.userId,customer.principal.userId);assert.deepEqual(principal.roles,['employee','tenant_admin']);
  assert.equal(await customer.sessions.resolvePrincipal(request),null);
  assert.equal(await factory('dev',epoch).resolvePrincipal(request),null);
  assert.equal(await factory('prod',epoch).resolvePrincipal(request),null);
  assert.equal(await sessions.verifyCsrf({ headers: { 'x-csrf-token': issued.csrfToken } },principal),true);
  assert.equal(await sessions.verifyCsrf({ headers: { 'x-csrf-token': 'x'.repeat(43) } },principal),false);
  for (const changed of [{ tenantId: randomUUID() },{ userId: randomUUID() },{ roles: ['employee'] },{ permissions: [] },
    { providerIdentity: { provider: 'email_code',reference: randomUUID() } },
    { session: { ...principal.session,id: randomUUID() } },
    { session: { ...principal.session,securityVersion: principal.session.securityVersion+1 } },
    { session: { ...principal.session,issuedAt: new Date(Date.parse(principal.session.issuedAt)-1).toISOString() } }]) {
    const candidate={ ...principal,...changed };
    assert.equal(await access.resolveCurrentAccess({ environment: 'int',securityEpoch: epoch,principal: candidate }),null);
  }
  assert.equal(await access.resolveCurrentAccess({ environment: 'dev',securityEpoch: epoch,principal }),null);
  // Actual explicit fresh-email + fresh pinned-SDK proof/link commits a new
  // Microsoft session in the same protected namespace. No provider HTTP leaves.
  const binding=createCustomerMicrosoftFlowBinding({ environment: 'int',secret: 'm'.repeat(48) });t.after(()=>binding.destroy());
  const flowRepository=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment: 'int',flowBinding: binding,
    auditRepository: customer.auditRepository });
  const clientId=randomUUID(),authority='https://login.microsoftonline.com/organizations';
  const provider=microsoftCodeSdkFixture({ clientId,authority,tenantId: randomUUID(),userId: randomUUID(),clock: Date.now });
  const authentication=createCustomerMicrosoftAuthenticationService({ repository: flowRepository,flowBinding: binding,
    entraClient: createFreshCustomerEntraClient({ clientId,authority,clientSecret: 'c'.repeat(48),publicOrigin: 'https://127.0.0.1',
      applicationFactory: ()=>provider.application() }) });
  const admission=createCustomerMicrosoftAdmissionService({ repository: flowRepository,auditService: customer.auditService,
    sessionService: sessions });
  const started=await authentication.startLink({ principal,sourceKey: 'f'.repeat(64),correlationId: randomUUID() });
  assert.equal(started.status,'redirect');const url=new URL(started.authorizationUrl);
  provider.state.sentNonce=url.searchParams.get('nonce');
  const pending=readCustomerMicrosoftTransactionCookie({ cookie: started.setCookie.split(';')[0] });
  const proof=await authentication.complete({ ...pending,state: url.searchParams.get('state'),code: 'synthetic-code',
    providerError: null,principal,correlationId: randomUUID() });assert.equal(proof.status,'link_confirmation_required');
  const confirmed=await admission.confirmLink({ ...readCustomerMicrosoftTransactionCookie({ cookie: proof.setCookie.split(';')[0] }),
    csrfToken: proof.csrfToken,principal,correlationId: randomUUID() },{ confirm: true });assert.equal(confirmed.status,'authenticated');
  assert.equal(await sessions.resolvePrincipal(request),null);
  request={ headers: { cookie: confirmed.setCookie.split(';')[0] } };principal=await sessions.resolvePrincipal(request);
  assert.ok(principal);assert.equal(principal.providerIdentity.provider,'microsoft_entra');assert.equal(provider.state.tokenRequests,1);
  identity={ ...principal,securityVersion: principal.session.securityVersion };
  const nextEpoch=randomUUID();
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,updated_at=clock_timestamp()
    WHERE environment='int'`,[nextEpoch]);
  assert.equal(await sessions.resolvePrincipal(request),null); // The old hash exists; current deployment custody denies it.
  const next=factory('int',nextEpoch);assert.equal(await next.resolvePrincipal(request),null);
  const fresh=await next.issue(identity,{ correlationId: randomUUID() });
  const freshRequest={ headers: { cookie: fresh.setCookie.split(';')[0] } };
  assert.ok(await next.resolvePrincipal(freshRequest));assert.equal(await sessions.resolvePrincipal(freshRequest),null);
  await pool.query('UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',[customer.tenantId,principal.userId]);
  assert.equal(await next.resolvePrincipal(freshRequest),null);
  assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
});

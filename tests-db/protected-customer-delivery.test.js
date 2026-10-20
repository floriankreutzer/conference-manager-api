import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { createProtectedCustomerAccessDeliveryWorker }
  from '../src/protected-customer-access-delivery-composition.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';

test('native protected dispatch qualifies only REAL outbox and holds the deployment barrier through provider acceptance',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end(),control.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const authorizationPolicy=createAuthorizationPolicy(),auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy });
  const sessions=createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48) });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const invitationService=createCustomerInvitationService({ environment: 'int',authorizationPolicy,auditService,
    repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',cipher,auditRepository,
      content: createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://127.0.0.1' }) }) });
  // Deliberate isolated ordinary authority fixtures produce candidate outbox;
  // they do not constitute protected login or real external identity grants.
  async function candidate(label) {
    const tenantId=randomUUID(),userId=randomUUID();
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,$2,'onboarding')",[tenantId,`Synthetic ${label}`]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic invitation admin')",[tenantId,userId]);
    await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",[tenantId,userId]);
    const session=await sessions.issue({ tenantId,userId,securityVersion: 1,...tenantAuthorizationSnapshot(['employee','tenant_admin']),
      providerIdentity: { provider: 'test_identity',reference: userId } },{ correlationId: randomUUID() });
    const invitation=(await invitationService.issueBatch({ principal: session.principal,tenantContext: { tenantId,status: 'onboarding' },
      correlationId: randomUUID() },{ commandId: randomUUID(),invitations: [
      { recipient: `${label}@example.test`,roles: ['tenant_admin'],locale: 'de' }] }))[0];
    return { tenantId,invitationId: invitation.id,session };
  }
  const unknown=await candidate('Unclassified'),real=await candidate('Real'),synthetic=await candidate('Synthetic');
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
  await pool.query(`UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp() WHERE id=$1`,
    [generationId]);
  let enter,release,sends=0;
  const entered=new Promise(resolve=>{ enter=resolve; }),pending=new Promise(resolve=>{ release=resolve; });
  const provider={ async send(message) { sends++;assert.equal(message.recipient,'Real@example.test');enter();return pending; } };
  const configuration={ pool,leasePool,environment: 'int',securityEpoch: epoch,cipher,provider };
  const worker=createProtectedCustomerAccessDeliveryWorker(configuration),first=worker.runOnce();
  assert.equal(await Promise.race([entered.then(()=>true),first.then(()=>false)]),true,'REAL_PROVIDER_CALL_REQUIRED');
  assert.deepEqual(await worker.runOnce(),{ status: 'busy' });
  await assert.rejects(control.query("SELECT protected_runtime_acquire_exclusive('int')"),/PROTECTED_RUNTIME_BUSY/);
  await assert.rejects(control.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[randomUUID()]),/PROTECTED_RUNTIME_BUSY/);
  release({ status: 'accepted',messageId: randomUUID() });assert.deepEqual(await first,{ status: 'accepted' });
  assert.deepEqual(await worker.runOnce(),{ status: 'idle' });assert.equal(sends,1);
  const rows=(await pool.query(`SELECT tenant_id,status,attempt_count,provider_message_id FROM customer_access_deliveries
    WHERE purpose='membership_invitation' ORDER BY tenant_id`)).rows;
  for (const denied of [unknown,synthetic]) {
    const row=rows.find(value=>value.tenant_id===denied.tenantId);
    assert.equal(row.status,'cancelled');assert.equal(row.attempt_count,0);assert.equal(row.provider_message_id,null);
  }
  const accepted=rows.find(value=>value.tenant_id===real.tenantId);
  assert.equal(accepted.status,'accepted');assert.equal(accepted.attempt_count,1);assert.ok(accepted.provider_message_id);
  const stale=createProtectedCustomerAccessDeliveryWorker({ ...configuration,securityEpoch: randomUUID() });
  await assert.rejects(stale.runOnce(),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });assert.equal(sends,1);
  assert.ok(await sessions.resolvePrincipal({ headers: { cookie: real.session.setCookie.split(';')[0] } }));
  assert.equal(await auditRepository.verifyTenantChain(real.tenantId),true);
});

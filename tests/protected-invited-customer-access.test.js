import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { deriveProtectedAuthenticationFlowSecret } from '../src/identity/protected-authentication-flow-secret.js';
import { createCustomerEmailFlowBinding } from '../src/identity/customer-email-flow-binding.js';
import { createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';
import { createPostgresCustomerEmailChallengeRepository } from '../src/persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresCustomerEmailAdmissionRepository } from '../src/persistence/postgres/customer-email-admission-repository.js';
import { createPostgresProtectedRealTenantScope } from '../src/persistence/postgres/protected-real-tenant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction,isPostgresTransactionActive } from '../src/persistence/postgres/transaction.js';

const environment='int',epoch=randomUUID(),now=new Date(),mailboxId=randomUUID();
const entry=()=>({ membershipId: randomUUID(),tenantId: randomUUID(),userId: null,userSecurityVersion: null,
  invitationId: randomUUID(),invitationRevision: 1 });
function fakePool(respond) {
  const queries=[];let connections=0,held=false;
  const client={ async query(query) { queries.push(query);return respond(query); },release() { held=false; } };
  const pool={ async connect() { assert.equal(held,false,'MAX_ONE_CONNECTION');held=true;connections++;return client; },
    async query(query) { assert.equal(held,false,'NO_POOL_QUERY_INSIDE_TRANSACTION');return client.query(query); } };
  return { pool,client,queries,connections: ()=>connections };
}
const flowBinding=createCustomerEmailFlowBinding({ environment,secret: 'f'.repeat(48) });

test('protected flow and code MACs separate purpose, environment, epoch and secret while ordinary formats remain unchanged',()=>{
  const configuration={ environment,securityEpoch: epoch,secret: 's'.repeat(48),purpose: 'customer-email-flow' };
  const derived=deriveProtectedAuthenticationFlowSecret(configuration);
  assert.match(derived,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(deriveProtectedAuthenticationFlowSecret({ ...configuration,securityEpoch: epoch.toUpperCase() }),derived);
  const context={ challengeId: randomUUID(),purpose: 'request' };
  const original=createCustomerEmailFlowBinding({ environment,secret: derived }),flow=original.issue(context);
  const proofContext={ challengeId: context.challengeId,mailboxId };
  const codeConfig={ ...configuration,purpose: 'customer-email-code' };
  const code=createEmailMailboxProofFactory({ environment,secret: deriveProtectedAuthenticationFlowSecret(codeConfig) });
  const proof=code.issue(proofContext);
  for (const change of [{ securityEpoch: randomUUID() },{ environment: 'dev' },{ environment: 'prod' },
    { secret: 't'.repeat(48) }]) {
    const next=createCustomerEmailFlowBinding({ environment: change.environment ?? environment,
      secret: deriveProtectedAuthenticationFlowSecret({ ...configuration,...change }) });
    assert.equal(next.matchesBrowser({ context,...flow }),false);next.destroy();
    const nextCode=createEmailMailboxProofFactory({ environment: change.environment ?? environment,
      secret: deriveProtectedAuthenticationFlowSecret({ ...codeConfig,...change }) });
    assert.equal(nextCode.matches({ context: proofContext,...proof }),false);
  }
  assert.notEqual(derived,deriveProtectedAuthenticationFlowSecret(codeConfig));
  for (const change of [{ secret: 'x' },{ secret: 'x'.repeat(513) },{ secret: 'x'.repeat(48)+'\n' },
    { purpose: 'cipher' },{ purpose: 'source-budget' },{ environment: 'demo' },{ securityEpoch: 'invalid' }]) {
    assert.throws(()=>deriveProtectedAuthenticationFlowSecret({ ...configuration,...change }),/INVALID/);
  }
  original.destroy();
});

test('code capture filters only the bounded original snapshot before proof creation and durable mail queueing',async()=>{
  const entries=[entry(),entry(),entry()];
  for (const allowed of [entries[1].membershipId,null]) {
    let issues=0,seals=0;const checked=[];
    const f=fakePool(query=>{
      if (query==='SELECT clock_timestamp() AS now') return { rows: [{ now }] };
      switch (query?.name) {
        case 'customer-email-retention-try-lock': return { rows: [{ acquired: false }] };
        case 'customer-email-budget-lock': return { rowCount: 1,rows: [{ window_started_at: now,
          issue_count: 0,failure_count: 0,last_issued_at: null }] };
        case 'customer-email-mailbox-lookup': return { rows: [{ id: mailboxId }] };
        case 'customer-email-admission-snapshot': return { rows: entries };
        default: return { rowCount: 1,rows: [] };
      }
    });
    const repository=createPostgresCustomerEmailChallengeRepository(f.pool,{ environment,flowBinding,
      cipher: { recipientLookup: ()=>'a'.repeat(64),seal() { seals++;return {}; } },
      proofFactory: { issue() { issues++;return { browserToken: Buffer.alloc(32,7).toString('base64url'),code: '00001234',
        codeVerifier: 'c'.repeat(64),browserVerifier: 'd'.repeat(64) }; },matches() {} },
      content: { mailboxSignInCode: ()=>({ text: 'synthetic' }) },
      tenantEligibility: { async allowsWithClient(client,tenantId,member) {
        assert.equal(isPostgresTransactionActive(f.pool,client),true);checked.push({ tenantId,...member });
        assert.deepEqual(member,{ membershipId: entries.find(item=>item.membershipId===member?.membershipId)?.membershipId });
        return member.membershipId===allowed;
      } } });
    assert.equal((await repository.request({ recipient: 'Synthetic@example.test',locale: 'de',sourceKey: 'b'.repeat(64) })).status,
      'code_required');
    assert.deepEqual(checked,entries.map(item=>({ tenantId: item.tenantId,membershipId: item.membershipId })));
    const stored=f.queries.find(query=>query?.name==='customer-email-challenge-insert').values;
    assert.deepEqual(JSON.parse(stored[7]),allowed===null ? [] : [entries[1]]);
    assert.equal(stored[2],allowed===null ? null : mailboxId);
    assert.equal(issues,allowed===null ? 0 : 1);assert.equal(seals,issues);
    assert.equal(f.queries.filter(query=>query?.name==='customer-email-code-enqueue').length,issues);
  }
});

test('choices qualify the captured member before label projection using one transaction; admission denial mutates nothing',async()=>{
  const entries=[entry(),entry(),entry()],challengeId=randomUUID(),browser=flowBinding.issue({ challengeId,purpose: 'choice' });
  const challenge={ id: challengeId,mailbox_id: mailboxId,consumed_at: null,verified_at: now,
    expires_at: new Date(now.getTime()+300_000),choice_verifier: browser.browserVerifier,admission_snapshot: entries };
  for (const result of [false,null,undefined,'true',1,true]) {
    const f=fakePool(query=>{
      if (query==='SELECT clock_timestamp() AS now') return { rows: [{ now }] };
      if (query?.name==='customer-email-admission-challenge-read') return { rows: [challenge] };
      if (query?.name==='customer-email-choice-current') return { rows: entries.map((item,index)=>({ id: item.membershipId,
        tenant_id: item.tenantId,user_id: null,invitation_id: item.invitationId,revision: 1,
        display_name: index===0 ? '\nPRIVATE_INVALID_LABEL' : 'Real customer' })) };
      throw new Error('UNEXPECTED_QUERY:'+String(query?.name ?? query));
    });
    // Transaction statements are infrastructure, not business queries.
    const original=f.client.query;f.client.query=async query=>typeof query==='string' && query!=='SELECT clock_timestamp() AS now'
      ? {} : original(query);
    const checked=[];
    const repository=createPostgresCustomerEmailAdmissionRepository(f.pool,{ environment,flowBinding,
      auditRepository: { async appendWithClient() { throw new Error('NO_AUDIT_ON_DENIAL'); } },
      tenantEligibility: { async allowsWithClient(client,tenantId,member) {
        assert.equal(isPostgresTransactionActive(f.pool,client),true);checked.push({ tenantId,...member });
        return member.membershipId===entries[1].membershipId ? result : false;
      } } });
    const input={ challengeId,browserToken: browser.browserToken,csrfToken: browser.csrfToken };
    const choices=await repository.choices(input);
    assert.deepEqual(choices.items,result===true ? [{ membershipId: entries[1].membershipId,displayName: 'Real customer' }] : []);
    assert.deepEqual(checked,entries.map(item=>({ tenantId: item.tenantId,membershipId: item.membershipId })));
    assert.equal(f.connections(),1);
    assert.deepEqual(await repository.admit({ ...input,membershipId: entries[0].membershipId,correlationId: randomUUID(),
      auditEventFor() { throw new Error('NO_EVENT'); },issueSession() { throw new Error('NO_SESSION'); } }),{ status: 'rejected' });
    assert.equal(f.connections(),2);
    assert.equal(f.queries.some(query=>query?.name==='customer-email-admission-tenant-lock'),false);
  }
});

test('REAL admission acquires the Tenant write lock directly under the exact shared deployment lease',async()=>{
  const respond=query=>query?.text?.includes('pg_try_advisory') ? { rows: [{ acquired: true }] } : { rowCount: 1,rows: [] };
  const business=fakePool(respond),lease=fakePool(respond),scope={ environment,securityEpoch: epoch };
  const qualification=createPostgresProtectedRealTenantScope(business.pool,scope);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.pool,leasePool: lease.pool,...scope });
  await assert.rejects(withPostgresTransaction(business.pool,
    client=>qualification.lockAdmissionWithClient(client,randomUUID())),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  await scopes.withShared(()=>withPostgresTransaction(business.pool,async client=>{
    assert.equal(await qualification.lockAdmissionWithClient(client,randomUUID()),true);
  }));
  const query=business.queries.find(value=>value?.name==='protected-admission-real-tenant-lock');
  assert.match(query.text,/FOR UPDATE OF tenant/);assert.doesNotMatch(query.text,/FOR SHARE OF deployment/);
  assert.match(query.text,/deployment.security_epoch=\$2/);
});

test('owned anonymous entry points reject a stale deployment before any business read, budget or unknown-recipient allocation',async()=>{
  const business=fakePool(()=>{ throw new Error('NO_BUSINESS_WORK_WITHOUT_DEPLOYMENT'); });
  const lease=fakePool(query=>query?.text?.includes('pg_try_advisory')
    ? { rows: [{ acquired: true }] } : { rowCount: 0,rows: [] });
  const access=createProtectedInvitedCustomerAccess({ pool: business.pool,leasePool: lease.pool,environment,securityEpoch: epoch,
    publicOrigin: 'https://127.0.0.1',cipher: { recipientLookup() {},seal() {},open() {},commandDigest() {} },
    auditHmacSecret: 'a'.repeat(48),
    csrfSecret: 's'.repeat(48),emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),emailSourceSecret: 'b'.repeat(48) });
  for (const method of ['request','pending','verify','choices','select']) {
    await assert.rejects(access.service[method]({ recipient: 'Unknown@example.test',locale: 'de',sourceAddress: '127.0.0.1' }),
      { code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  }
  for (const method of ['list','issueBatch','reissue','revoke']) {
    await assert.rejects(access.invitationService[method]({}),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  }
  assert.equal(business.connections(),0);assert.equal(business.queries.length,0);assert.equal(lease.connections(),9);
});

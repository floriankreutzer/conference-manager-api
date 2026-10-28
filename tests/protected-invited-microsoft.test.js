import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPostgresCustomerMicrosoftFlowRepository } from '../src/persistence/postgres/customer-microsoft-flow-repository.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { deriveProtectedAuthenticationFlowSecret } from '../src/identity/protected-authentication-flow-secret.js';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { isPostgresTransactionActive } from '../src/persistence/postgres/transaction.js';

const now=new Date(),environment='int',securityEpoch=randomUUID();
const binding=createCustomerMicrosoftFlowBinding({ environment,secret: deriveProtectedAuthenticationFlowSecret({
  environment,securityEpoch,secret: 'm'.repeat(48),purpose: 'customer-microsoft-flow' }) });
const member=()=>({ membershipId: randomUUID(),tenantId: randomUUID(),userId: randomUUID(),userSecurityVersion: 1 });
function fixture(respond) {
  const queries=[];let active=false,connections=0;
  const client={ async query(query) {
    queries.push(query);
    if (query==='SELECT clock_timestamp() AS now') return { rows: [{ now }] };
    if (typeof query==='string') return {};
    return respond(query);
  },release() { active=false; } };
  const pool={ async connect() { assert.equal(active,false,'MAX_ONE_CONNECTION');active=true;connections++;return client; },
    async query(query) { assert.equal(active,false,'NO_POOL_READ_INSIDE_TRANSACTION');return client.query(query); } };
  return { pool,client,queries,connections: ()=>connections };
}

test('Microsoft capture qualifies only accepted bounded candidates before acquiring the protocol row lock',async()=>{
  const entries=[member(),member(),member()],flowId=randomUUID();
  const browser=binding.issueBrowser({ flowId,purpose: 'login',stage: 'authorization' });
  const row={ id: flowId,purpose: 'login',status: 'redeeming',browser_verifier: browser.browserVerifier,
    created_at: now,expires_at: new Date(now.getTime()+600_000) };
  const f=fixture(query=>{
    if (['customer-microsoft-flow-read','customer-microsoft-flow-lock'].includes(query.name)) return { rows: [row] };
    if (query.name==='customer-microsoft-admission-capture') return { rows: entries.map(entry=>({ membership_id: entry.membershipId,
      tenant_id: entry.tenantId,user_id: entry.userId,security_version: 1 })) };
    if (query.name==='customer-microsoft-flow-verified') return { rowCount: 1,rows: [] };
    throw new Error('UNEXPECTED_QUERY:'+query.name);
  });
  const visited=[];
  const repository=createPostgresCustomerMicrosoftFlowRepository(f.pool,{ environment,flowBinding: binding,
    tenantEligibility: { async allowsWithClient(client,tenantId,context) {
      assert.equal(isPostgresTransactionActive(f.pool,client),true);
      assert.equal(f.queries.some(query=>query?.name==='customer-microsoft-flow-lock'),false);
      visited.push({ tenantId,...context });return context.membershipId===entries[1].membershipId;
    },async lockAdmissionWithClient() { throw new Error('NO_ADMISSION_DURING_CAPTURE'); } } });
  const choice=binding.issueBrowser({ flowId,purpose: 'login',stage: 'choice' });
  assert.equal(await repository.verified({ flowId,browserToken: browser.browserToken,choiceVerifier: choice.browserVerifier,
    correlationId: randomUUID(),principal: null,identity: { provider: 'microsoft_entra',tenantReference: randomUUID(),
      userReference: randomUUID(),authenticatedAt: now.toISOString() } }),true);
  assert.deepEqual(visited,entries.map(entry=>({ tenantId: entry.tenantId,membershipId: entry.membershipId })));
  assert.deepEqual(JSON.parse(f.queries.find(query=>query?.name==='customer-microsoft-flow-verified').values[7]),[entries[1]]);
});

test('Microsoft choice labels and admission are REAL-qualified without expanding snapshots or allocating a second connection',async()=>{
  const entries=[member(),member()],flowId=randomUUID(),browser=binding.issueBrowser({ flowId,purpose: 'login',stage: 'choice' });
  const row={ id: flowId,purpose: 'login',status: 'verified',verified_at: now,expires_at: new Date(now.getTime()+300_000),
    choice_verifier: browser.browserVerifier,admission_snapshot: entries,provider_tenant_reference: randomUUID(),
    provider_user_reference: randomUUID() };
  const f=fixture(query=>{
    if (query.name==='customer-microsoft-flow-read') return { rows: [row] };
    if (query.name==='customer-microsoft-admission-choices') return { rows: entries.map((entry,index)=>({ id: entry.membershipId,
      tenant_id: entry.tenantId,user_id: entry.userId,security_version: 1,display_name: index===0 ? '\nPRIVATE' : 'Real customer' })) };
    throw new Error('UNEXPECTED_BUSINESS_QUERY:'+query.name);
  });
  const repository=createPostgresCustomerMicrosoftFlowRepository(f.pool,{ environment,flowBinding: binding,
    tenantEligibility: { async allowsWithClient(client,tenantId,context) {
      assert.equal(isPostgresTransactionActive(f.pool,client),true);
      assert.equal(entries.find(entry=>entry.membershipId===context.membershipId)?.tenantId,tenantId);
      return context.membershipId===entries[1].membershipId;
    },async lockAdmissionWithClient(client,tenantId,context) {
      assert.equal(isPostgresTransactionActive(f.pool,client),true);assert.equal(tenantId,entries[0].tenantId);
      assert.deepEqual(context,{ membershipId: entries[0].membershipId });return false;
    } } });
  const choices=await repository.choices({ flowId,browserToken: browser.browserToken });
  assert.deepEqual(choices.items,[{ membershipId: entries[1].membershipId,displayName: 'Real customer' }]);
  assert.equal(f.connections(),1);
  assert.equal((await repository.admit({ flowId,browserToken: browser.browserToken,csrfToken: browser.csrfToken,
    membershipId: entries[0].membershipId,correlationId: randomUUID(),issueSession() { throw new Error('NO_SESSION_ON_DENIAL'); } }))
    .status,'rejected');
  assert.equal(f.connections(),2);assert.equal(f.queries.some(query=>query?.name==='customer-microsoft-flow-consume'),false);
});

test('Microsoft pending nonce/PKCE/browser/confirmation custody changes with the protected UUID epoch',()=>{
  const next=createCustomerMicrosoftFlowBinding({ environment,secret: deriveProtectedAuthenticationFlowSecret({ environment,
    securityEpoch: randomUUID(),secret: 'm'.repeat(48),purpose: 'customer-microsoft-flow' }) });
  const state=binding.issueState({ purpose: 'login' });
  const changed=next.protocol({ state: state.state,purpose: 'login' });
  assert.notEqual(state.nonceHash,changed.nonceHash);assert.notEqual(state.codeChallenge,changed.codeChallenge);
  for (const context of [{ flowId: randomUUID(),purpose: 'login',stage: 'authorization' },
    { flowId: randomUUID(),purpose: 'login',stage: 'choice' },{ flowId: randomUUID(),purpose: 'link',stage: 'confirmation' }]) {
    const browser=binding.issueBrowser(context);
    assert.equal(next.matchesBrowser({ context,...browser }),false);assert.equal(next.verifyCsrf({ context,...browser }),false);
  }
  next.destroy();
});

test('unqualified email principals cannot start a Microsoft link or read account state, even with a valid server session shape',async()=>{
  const principal={ tenantId: randomUUID(),userId: randomUUID(),providerIdentity: { provider: 'email_code',reference: randomUUID() },
    roles: ['employee'],permissions: [],session: { id: randomUUID(),securityVersion: 1,issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime()+3_600_000).toISOString() } };
  for (const allowed of [false,null,undefined,1,'true']) {
    const f=fixture(()=>{ throw new Error('NO_BUSINESS_READ_OR_MUTATION_BEFORE_REAL'); });
    const qualify=async client=>{ assert.equal(isPostgresTransactionActive(f.pool,client),true);return allowed; };
    const repository=createPostgresCustomerMicrosoftFlowRepository(f.pool,{ environment,flowBinding: binding,
      tenantEligibility: { allowsWithClient: qualify,lockAdmissionWithClient: qualify } });
    assert.deepEqual(await repository.accountState({ principal }),{ status: 'rejected' });
    assert.equal(await repository.create({ flowId: randomUUID(),purpose: 'link',principal,correlationId: randomUUID(),
      stateHash: 'a'.repeat(64),nonceHash: 'b'.repeat(64),browserVerifier: 'c'.repeat(64),sourceKey: 'd'.repeat(64) }),null);
    assert.equal(f.queries.some(query=>typeof query==='object'),false);
  }
});

test('owned Microsoft entry points require current deployment before protocol, account, provider or source-budget work',async()=>{
  const business=fixture(()=>{ throw new Error('NO_BUSINESS_WITHOUT_CURRENT_DEPLOYMENT'); });
  const lease=fixture(query=>query?.text?.includes('pg_try_advisory')
    ? { rows: [{ acquired: true }] } : { rowCount: 0,rows: [] });
  const noProvider=()=>{ throw new Error('NO_PROVIDER_WITHOUT_CURRENT_DEPLOYMENT'); };
  const configuration={ pool: business.pool,leasePool: lease.pool,environment,securityEpoch,publicOrigin: 'https://127.0.0.1',
    cipher: { recipientLookup() {},seal() {},open() {},commandDigest() {} },auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48),
    emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),emailSourceSecret: 'b'.repeat(48),
    microsoftFlowSecret: 'm'.repeat(48),microsoftClient: { authorizationUrl: noProvider,redeemAuthorizationCode: noProvider,
      verifyPrimary: noProvider } };
  const access=createProtectedInvitedCustomerAccess(configuration);
  for (const [service,names] of [[access.microsoft.authenticationService,['startLogin','startLink','complete']],
    [access.microsoft.admissionService,['accountState','choices','select','linkConfirmation','confirmLink']]]) {
    for (const name of names) await assert.rejects(service[name]({}),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  }
  const next=createProtectedInvitedCustomerAccess({ ...configuration,securityEpoch: randomUUID() });
  assert.equal(access.microsoft.sourceKey.fingerprint('127.0.0.1'),next.microsoft.sourceKey.fingerprint('127.0.0.1'));
  assert.equal(business.connections(),0);assert.equal(business.queries.length,0);
});

test('explicit member-aware account and link qualification cannot fall back to Tenant-only authority',async()=>{
  const principal={ tenantId: randomUUID(),userId: randomUUID(),providerIdentity: { provider: 'email_code',reference: randomUUID() },
    roles: ['employee'],permissions: [],session: { id: randomUUID(),securityVersion: 1,issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime()+3_600_000).toISOString() } };
  const f=fixture(()=>{ throw new Error('NO_BUSINESS_AFTER_MEMBER_DENIAL'); }),visited=[];
  const deny=method=>async(client,value)=>{
    assert.equal(isPostgresTransactionActive(f.pool,client),true);assert.deepEqual(value,principal);
    visited.push(method);return false;
  };
  const repository=createPostgresCustomerMicrosoftFlowRepository(f.pool,{ environment,flowBinding: binding,
    tenantEligibility: { allowsPrincipalWithClient: deny('account'),lockPrincipalAdmissionWithClient: deny('link'),
      allowsWithClient() { throw new Error('NO_TENANT_ONLY_FALLBACK'); },
      lockAdmissionWithClient() { throw new Error('NO_TENANT_ONLY_FALLBACK'); } } });
  assert.deepEqual(await repository.accountState({ principal }),{ status: 'rejected' });
  assert.equal(await repository.create({ flowId: randomUUID(),purpose: 'link',principal,correlationId: randomUUID(),
    stateHash: 'a'.repeat(64),nonceHash: 'b'.repeat(64),browserVerifier: 'c'.repeat(64),sourceKey: 'd'.repeat(64) }),null);
  assert.deepEqual(visited,['account','link']);assert.equal(f.queries.some(query=>typeof query==='object'),false);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createEntraAuthService } from '../src/identity/entra-auth-service.js';
import { createEntraClient } from '../src/identity/entra-client.js';
import { createPlatformEntraPrimaryAuthService } from '../src/platform/identity/entra-auth-service.js';
import { createPlatformEntraPrimaryClient } from '../src/platform/identity/entra-client.js';
import { microsoftCodeSdkFixture } from './support/microsoft-code-sdk-fixture.js';

const clientId='72000000-0000-4000-8000-000000000001',tenantId='72000000-0000-4000-8000-000000000002';
const userId='72000000-0000-4000-8000-000000000003',correlationId='72000000-0000-4000-8000-000000000004';
const now=Date.parse('2026-10-20T12:00:00.000Z'),state='S'.repeat(43),secret='transaction-key-for-actual-sdk-test-only-00001';
const hash=value=>createHash('sha256').update(value).digest('hex');
function harness(platform=false) {
  const authority=`https://login.microsoftonline.com/${platform ? tenantId : 'organizations'}`,origin='https://127.0.0.1';
  const fixture=microsoftCodeSdkFixture({ clientId,authority,tenantId,userId,clock: ()=>now });
  const rows=new Map(),calls={ consumed: 0,resolved: 0,pending: 0,sessions: 0 };
  const repository={ async create(value){ rows.set(value.stateHash,value); },async consume(value){
    const row=rows.get(value.stateHash);if (!row) return null;rows.delete(value.stateHash);calls.consumed++;return row;
  } };
  function service() {
    const redirectUri=origin+(platform ? '/api/v1/platform/auth/microsoft/callback' : '/api/v1/auth/microsoft/callback');
    const common={ clientId,clientSecret: 's'.repeat(48),authority,publicOrigin: origin,redirectUri,clock: ()=>now,
      application: fixture.application() };
    if (platform) {
      const entraClient=createPlatformEntraPrimaryClient({ ...common,tenantReference: tenantId });
      return createPlatformEntraPrimaryAuthService({ repository,entraClient,transactionSecret: secret,publicOrigin: origin,
        securityEpoch: 7,randomToken: ()=>state,
        passkeyAuthService: { async startLogin(assertion){
          const identity=await entraClient.verifyPrimary(assertion);assert.equal(identity.subjectReference,userId);calls.pending++;
          return { status: 'passkey_required',state: 'pending',options: {},setCookie: 'synthetic-pending-cookie' };
        } },auditService: { createUnmappedAuthenticationFailure: value=>value,async record(){} } });
    }
    const entraClient=createEntraClient(common);
    return createEntraAuthService({ repository,entraClient,transactionSecret: secret,publicOrigin: origin,clock: ()=>now,
      randomToken: ()=>state,identityResolver: { async resolve(identity){
        calls.resolved++;assert.equal(identity.userReference,userId);return { status: 'onboarding_required' };
      } },sessionService: { async issue(){ calls.sessions++;throw new Error('UNEXPECTED_BUSINESS_SESSION'); } } });
  }
  async function start() {
    const value=await service().start({ correlationId });const nonce=new URL(value.authorizationUrl).searchParams.get('nonce');
    fixture.state.sentNonce=nonce;
    return { value,nonce,browserBinding: value.setCookie.split(';')[0].split('=')[1] };
  }
  return { service,fixture,rows,calls,start };
}
for (const platform of [false,true]) {
  test(`${platform ? 'Platform' : 'Customer'} recovers the nonce on a new service and passes actual SDK validation`,async()=>{
    const h=harness(platform),started=await h.start();assert.match(started.nonce,/^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(started.nonce,state);assert.notEqual(started.nonce,started.browserBinding);
    const stored=[...h.rows.values()][0];assert.equal(stored.nonceHash,hash(started.nonce));
    assert.doesNotMatch(JSON.stringify(stored),new RegExp(started.nonce));
    const result=await h.service().complete({ state,code: 'synthetic-code',browserBinding: started.browserBinding,correlationId });
    assert.equal(result.status,platform ? 'passkey_required' : 'onboarding_required');assert.equal(h.fixture.state.tokenRequests,1);
    assert.equal(h.calls.sessions,0);assert.equal(h.rows.size,0);
    await assert.rejects(h.service().complete({ state,code: 'replay-code',
      browserBinding: started.browserBinding,correlationId }),/STATE_INVALID/);
    assert.equal(h.fixture.state.tokenRequests,1);
  });
  test(`${platform ? 'Platform' : 'Customer'} rejects old random-nonce state before SDK exchange`,async()=>{
    const h=harness(platform),started=await h.start();[...h.rows.values()][0].nonceHash=hash('N'.repeat(43));
    await assert.rejects(h.service().complete({ state,code: 'synthetic-code',
      browserBinding: started.browserBinding,correlationId }),/NONCE|INPUT/);
    assert.equal(h.fixture.state.tokenRequests,0);assert.equal(h.calls.resolved,0);assert.equal(h.calls.pending,0);
    assert.equal(h.calls.sessions,0);assert.equal(h.rows.size,0);
  });
  test(`${platform ? 'Platform' : 'Customer'} real SDK rejects changed token nonce before local resolution`,async()=>{
    const h=harness(platform),started=await h.start();h.fixture.state.returnedNonce='W'.repeat(43);
    await assert.rejects(h.service().complete({ state,code: 'synthetic-code',
      browserBinding: started.browserBinding,correlationId }),/REDEMPTION_FAILED/);
    assert.equal(h.fixture.state.tokenRequests,1);assert.equal(h.calls.resolved,0);
    assert.equal(h.calls.pending,0);assert.equal(h.calls.sessions,0);
  });
}

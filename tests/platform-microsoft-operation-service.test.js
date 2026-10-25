import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPlatformMicrosoftOperationService } from '../src/platform/identity/microsoft-operation-service.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { createPlatformClaimPolicy } from '../src/platform/identity/claim-policy.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const id=n=>`d1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const NOW=Date.parse('2026-10-24T12:00:00.000Z'),NORMAL='cm:ms:mfa:v1',FRESH='cm:ms:fresh:v1';
const provider='microsoft_entra_platform',issuer=`https://login.microsoftonline.com/${id(10)}/v2.0`;
const roles=['platform_security_admin','platform_tenant_operator'];
const hash='a'.repeat(64),otherHash='b'.repeat(64);
const principal={ operatorId: id(1),providerIdentity: { provider,tenantReference: id(10),subjectReference: id(11) },
  roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 6,targetScope: { mode: 'all',securityVersion: 6 },
  assurance: { level: 'mfa',authenticationContext: NORMAL,authenticatedAt: new Date(NOW-1000).toISOString() },
  session: { id: id(2),issuedAt: new Date(NOW).toISOString(),expiresAt: new Date(NOW+3600000).toISOString(),
    securityEpoch: 7,securityVersion: 6,stepUpExpiresAt: null } };
const cookieValue=serialized=>serialized.slice(serialized.indexOf('=')+1).split(';')[0];

// In-memory service-port fixture only. Native transaction, real provider and
// different-site cookie acceptance require the subsequent owned adapters/CI.
function fixture({ onRejection }={}) {
  let now=NOW,row=null,current=structuredClone(principal),sessionNumber=20,claimPatch={},mutationFault=false,clientFailure=null;
  const calls={ create: 0,redeem: 0,verify: 0,authenticate: 0,sessionWrites: 0,business: 0 };
  const assertions=new WeakMap();let authorization;
  const client={ async authorizationUrl(value) { authorization=value;return 'https://login.microsoftonline.com/operation'; },
    async redeemAuthorizationCode(value) {
      calls.redeem++;if (clientFailure) throw clientFailure;
      assert.equal(value.authenticationContext,FRESH);assert.equal(value.expectedNonce,authorization.nonce);
      assert.equal(createHash('sha256').update(value.expectedNonce).digest('hex'),value.expectedNonceHash);
      assert.equal(createHash('sha256').update(value.codeVerifier,'ascii').digest('base64url'),authorization.codeChallenge);
      const assertion=Object.freeze({});assertions.set(assertion,{ provider,issuer,audience: id(12),tenantReference: id(10),
        subjectReference: id(11),authenticationContext: FRESH,authenticatedAt: new Date(now).toISOString(),...claimPatch });
      return assertion;
    },async verify(assertion) {
      calls.verify++;const claims=assertions.get(assertion);assertions.delete(assertion);
      if (!claims) throw new Error('not opaque');return { verified: true,claims };
    } };
  const repository={ async create(value) {
    calls.create++;row={ ...value,status: 'pending',operatorId: value.expectedPrincipal.operatorId,
      operatorSecurityVersion: value.expectedPrincipal.securityVersion,expectedSessionId: value.expectedPrincipal.session.id,
      providerIdentity: value.expectedPrincipal.providerIdentity,createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now+value.ttlSeconds*1000).toISOString() };return true;
  },async findPending(lookup) {
    if (!row || ['stateHash','browserHash','protectedSecurityEpoch','securityEpoch','environment']
      .some(key=>row[key]!==lookup[key])) return null;return structuredClone(row);
  },async verify({ identity,...lookup }) {
    if (!(await repository.findPending(lookup)) || row.status!=='pending') return false;
    row.status='verified';row.authenticatedAt=identity.assurance.authenticatedAt;return true;
  },async reject() { if (row) row.status='failed'; },async authenticate(lookup,work) {
    calls.authenticate++;if (!(await repository.findPending(lookup)) || row.status!=='verified') return null;
    const before={ row: structuredClone(row),current: structuredClone(current),writes: calls.sessionWrites,business: calls.business };
    try {
      row.status='consumed';
      const result=await work({ operatorId: row.operatorId,providerIdentity: row.providerIdentity,roles: current.roles,
        securityVersion: row.operatorSecurityVersion,scopeMode: current.targetScope.mode,
        authenticatedAt: row.authenticatedAt,correlationId: row.correlationId });
      if (mutationFault) throw new Error('private-commit-fault');return result;
    } catch (error) {
      row=before.row;current=before.current;calls.sessionWrites=before.writes;calls.business=before.business;throw error;
    }
  } };
  function issued(identity) {
    calls.sessionWrites++;const stepped=identity.assurance.level==='step_up';
    current={ ...identity,session: { id: id(sessionNumber++),issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now+3600000).toISOString(),securityVersion: identity.securityVersion,securityEpoch: 7,
      stepUpExpiresAt: stepped ? new Date(now+300000).toISOString() : null } };
    return { principal: structuredClone(current),csrfToken: Buffer.alloc(32,3).toString('base64url'),
      setCookie: 'synthetic-normal-cookie' };
  }
  const sessionService={ async resolvePrincipal() { return current; },
    async rotate(_source,identity) { return issued(identity); },async issue(identity) { return issued(identity); },
    async revoke() { calls.sessionWrites++;return true; } };
  const service=()=>createPlatformMicrosoftOperationService({ onRejection,repository,entraClient: client,sessionService,
    claimPolicy: createPlatformClaimPolicy({ provider,issuer,audience: id(12),tenantReference: id(10),
      mfaAuthenticationContext: NORMAL,stepUpAuthenticationContext: FRESH }),
    environment: 'int',protectedSecurityEpoch: id(13),securityEpoch: 7,transactionSecret: 's'.repeat(48),clock: ()=>now,
    tokenFactory: ()=>Buffer.alloc(32,4).toString('base64url'),idFactory: ()=>id(14) });
  async function prepare() {
    const started=await service().startStepUp(current,{ operationHash: hash,correlationId: id(15) });
    const cookie=cookieValue(started.setCookies[0]);
    return { started,cookie,input: { cookie,state: started.state,operationHash: hash,request: {} } };
  }
  return { service,prepare,calls,record: ()=>row,current: ()=>current,
    clock: value=>{ now=value; },claims: value=>{ claimPatch=value; },fault: ()=>{ mutationFault=true; },
    clientFailure: value=>{ clientFailure=value; },source: value=>{ current=value; } };
}

for (const continuation of [false,true]) test(
  `Microsoft callback is inert; exact proof executes once with private elevated authority, continuation=${continuation}`,async()=>{
  const f=fixture(),{ started,cookie,input }=await f.prepare(),service=f.service();
  assert.equal(started.status,'microsoft_required');assert.match(started.setCookies[0],/SameSite=Lax/);
  assert.match(started.setCookies[1],/SameSite=Strict/);
  assert.deepEqual(await service.pendingStatus(input),{ status: 'pending' });
  const verified=await service.complete({ state: started.state,cookie,code: 'synthetic-code' });
  assert.equal(verified.status,'operation_verified');assert.equal(verified.principal,undefined);assert.equal(verified.csrfToken,undefined);
  assert.deepEqual(await service.pendingStatus(input),{ status: 'verified' });
  assert.equal(f.calls.sessionWrites,0);assert.equal(f.calls.authenticate,0);assert.equal(f.calls.business,0);
  assert.match(verified.setCookies[1],/SameSite=Strict/);
  let captured;
  const completed=await service[continuation ? 'executeStepUpWithContinuation' : 'executeStepUp'](input,context=>{
    captured=context;
    assert.throws(()=>f.service().verifiedOperationPrincipal(context,hash),/OPERATION_REJECTED/);
    const proof=continuation ? service.verifiedOperationWithContinuation(context,hash)
      : { principal: service.verifiedOperationPrincipal(context,hash) };
    assert.equal(proof.principal.assurance.authenticationContext,FRESH);
    assert.equal(proof.principal.assurance.level,'step_up');
    if (continuation) {
      assert.equal(proof.continuationPrincipal.assurance.authenticationContext,NORMAL);
      assert.equal(proof.continuationPrincipal.assurance.authenticatedAt,proof.principal.assurance.authenticatedAt);
      assert.notEqual(proof.continuationPrincipal.session.id,proof.principal.session.id);
    }
    assert.throws(()=>service.verifiedOperationPrincipal(context,hash),/OPERATION_REJECTED/);
    f.calls.business++;return { status: 'changed' };
  });
  assert.equal(completed.status,'operation_completed');assert.equal(completed.principal.assurance.level,'mfa');
  assert.equal(completed.principal.assurance.authenticationContext,NORMAL);assert.equal(completed.setCookies.length,2);
  assert.equal(f.calls.business,1);assert.equal(f.record().status,'consumed');
  assert.throws(()=>service.verifiedOperationPrincipal(captured,hash),/OPERATION_REJECTED/);
  await assert.rejects(service.executeStepUp(input,()=>{ throw new Error('must not execute'); }),/OPERATION_REJECTED/);
});

test('exact operation, browser, current source, version and expiry are mandatory before mutation',async()=>{
  for (const change of ['hash','cookie','session','version','provider','expiry']) {
    const f=fixture(),{ started,cookie,input }=await f.prepare(),service=f.service();
    await service.complete({ state: started.state,cookie,code: 'synthetic-code' });
    if (change==='hash') input.operationHash=otherHash;
    if (change==='cookie') input.cookie=input.cookie.replace(/^./,'Z');
    if (change==='session') f.source({ ...f.current(),session: { ...f.current().session,id: id(99) } });
    if (change==='version') f.source({ ...f.current(),securityVersion: 7,targetScope: { mode: 'all',securityVersion: 7 },
      session: { ...f.current().session,securityVersion: 7 } });
    if (change==='provider') f.source({ ...f.current(),providerIdentity: { ...f.current().providerIdentity,subjectReference: id(99) } });
    if (change==='expiry') f.clock(NOW+120000);
    await assert.rejects(service.executeStepUp(input,()=>{ f.calls.business++; }),/OPERATION_REJECTED/);
    assert.equal(f.calls.authenticate,0);assert.equal(f.calls.sessionWrites,0);assert.equal(f.calls.business,0);
  }
});

test('wrong provider subject/context and arbitrary claims cannot verify or create operation authority',async()=>{
  for (const patch of [{ subjectReference: id(99) },{ authenticationContext: NORMAL },{ roles: ['platform_security_admin'] },
    { authenticatedAt: new Date(NOW-61000).toISOString() }]) {
    const f=fixture(),{ started,cookie }=await f.prepare();f.claims(patch);
    await assert.rejects(f.service().complete({ state: started.state,cookie,code: 'synthetic-code' }),/OPERATION_REJECTED/);
    assert.equal(f.record().status,'failed');assert.equal(f.calls.sessionWrites,0);
  }
});

test('failed mutation/commit returns no success or strong cookie and discards opaque context',async()=>{
  for (const commit of [false,true]) {
    const f=fixture(),{ started,cookie,input }=await f.prepare(),service=f.service();
    await service.complete({ state: started.state,cookie,code: 'synthetic-code' });if (commit) f.fault();
    let captured;
    await assert.rejects(service.executeStepUpWithContinuation(input,context=>{
      captured=context;service.verifiedOperationWithContinuation(context,hash);f.calls.business++;
      if (!commit) throw new Error('private-mutation-fault');return { status: 'changed' };
    }),/private-(?:commit|mutation)-fault/);
    assert.equal(f.calls.business,0);assert.equal(f.calls.sessionWrites,0);assert.equal(f.record().status,'verified');
    assert.throws(()=>service.verifiedOperationPrincipal(captured,hash),/OPERATION_REJECTED/);
  }
});

test('provider refusal, callback replay and ordinary non-Microsoft sources never execute an operation',async()=>{
  const f=fixture(),{ started,cookie,input }=await f.prepare();
  const refused=await f.service().complete({ state: started.state,cookie,providerError: 'access_denied' });
  assert.equal(refused.status,'authentication_rejected');assert.equal(f.calls.redeem,0);
  await assert.rejects(f.service().executeStepUp(input,()=>{}),/OPERATION_REJECTED/);
  const other=fixture(),prepared=await other.prepare();
  await other.service().complete({ state: prepared.started.state,cookie: prepared.cookie,code: 'synthetic-code' });
  await assert.rejects(other.service().complete({ state: prepared.started.state,cookie: prepared.cookie,code: 'synthetic-code' }),
    /OPERATION_REJECTED/);assert.equal(other.calls.redeem,1);
  await assert.rejects(other.service().startStepUp({ ...principal,assurance: { ...principal.assurance,
    authenticationContext: 'cm:pk:v1' } },{ operationHash: hash,correlationId: id(15) }),/OPERATION_REJECTED/);
});

test('operation rejection diagnostics are closed, non-authoritative and contain no provider material',async()=>{
  for (const [error,reason] of [
    [new PlatformIdentityError('PLATFORM_ENTRA_AUTHENTICATION_NOT_FRESH'),'authentication_stale'],
    [new PlatformIdentityError('PLATFORM_ENTRA_ISSUED_AT_NOT_FRESH'),'issuance_stale'],
    [new PlatformIdentityError('PLATFORM_ENTRA_NONCE_INVALID'),'nonce_rejected'],
    [new PlatformIdentityError('PLATFORM_MICROSOFT_MFA_REQUIRED'),'mfa_missing'],
    [new PlatformIdentityError('PLATFORM_ENTRA_CODE_REDEMPTION_FAILED'),'exchange_failed'],
    [new PlatformIdentityError('PLATFORM_ENTRA_TOKEN_EXPIRED'),'token_expired'],
    [new PlatformIdentityError('PLATFORM_ENTRA_TOKEN_EXPIRY_MISSING'),'expiry_missing'],
    [new PlatformIdentityError('PLATFORM_ENTRA_TOKEN_EXPIRY_INVALID'),'expiry_invalid'],
    [new PlatformIdentityError('private-provider-code'),'rejected'],
    [new Error('private-provider-payload'),'unavailable'],
  ]) {
    const events=[],f=fixture({ onRejection: value=>events.push(value) }),{ started,cookie }=await f.prepare();
    f.clientFailure(error);
    await assert.rejects(f.service().complete({ state: started.state,cookie,code: 'synthetic-code' }),/OPERATION_REJECTED/);
    assert.deepEqual(events,[{ stage: 'redemption',reason }]);assert.ok(Object.isFrozen(events[0]));
    assert.equal(f.record().status,'failed');assert.equal(f.calls.business,0);assert.equal(f.calls.sessionWrites,0);
  }
  const refused=[],f=fixture({ onRejection: value=>refused.push(value) }),{ started,cookie }=await f.prepare();
  const result=await f.service().complete({ state: started.state,cookie,providerError: 'access_denied' });
  assert.equal(result.status,'authentication_rejected');assert.deepEqual(refused,[{ stage: 'provider',reason: 'provider_refused' }]);
  const broken=fixture({ onRejection: ()=>{ throw new Error('private-sink-failure'); } }),pending=await broken.prepare();
  broken.clientFailure(new Error('private-exchange'));
  await assert.rejects(broken.service().complete({ state: pending.started.state,cookie: pending.cookie,code: 'synthetic-code' }),
    /OPERATION_REJECTED/);
  assert.equal(broken.record().status,'failed');assert.equal(broken.calls.business,0);
});

test('successful verification emits no rejection diagnostic',async()=>{
  const events=[],f=fixture({ onRejection: value=>events.push(value) }),{ started,cookie }=await f.prepare();
  assert.equal((await f.service().complete({ state: started.state,cookie,code: 'synthetic-code' })).status,'operation_verified');
  assert.deepEqual(events,[]);assert.equal(f.record().status,'verified');assert.equal(f.calls.business,0);
});

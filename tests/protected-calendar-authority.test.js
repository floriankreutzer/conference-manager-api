import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPostgresProtectedCalendarAuthorityGuard } from '../src/persistence/postgres/protected-calendar-authority-guard.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { syntheticHandoffOperationHash,syntheticDelegationIdentityReference } from '../src/domain/synthetic-handoff.js';

const tenantId=randomUUID(),userId=randomUUID(),generationId=randomUUID(),operatorId=randomUUID(),flowId=randomUUID();
const scope={ environment: 'int',securityEpoch: randomUUID() },syntheticScope={ ...scope,platformSecurityEpoch: 7,
  customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
const binding={ flowId,stateHash: 'a'.repeat(64),browserVerifier: 'b'.repeat(64) };
const selection={ flowId,operatorId,generationId,slot: 'northwind',role: 'conference_manager' };
function principal(synthetic=true) {
  return { tenantId,userId,...tenantAuthorizationSnapshot(['employee','conference_manager']),
    providerIdentity: { provider: synthetic ? 'platform_delegation' : 'email_code',reference: synthetic
      ? syntheticDelegationIdentityReference({ generationId,operatorId,role: 'conference_manager' }) : randomUUID() },
    session: { id: randomUUID(),issuedAt: '2026-10-21T10:00:00.000Z',expiresAt: '2026-10-21T18:00:00.000Z',securityVersion: 3 } };
}
const authority={ integrationId: randomUUID(),integrationProvider: 'synthetic_calendar',identityProvider: 'platform_delegation',
  providerConnectionReference: `synthetic:${generationId}`,roomId: 'room-01',
  providerResourceReference: `synthetic-room:${tenantId}:room-01`,calendarWriteEnabled: true };
const currentRequest={ tenantId,id: 'request-01',roomId: 'room-01',startsAt: '2028-01-01T10:00:00.000Z',
  endsAt: '2028-01-01T11:00:00.000Z' };
function fixture({ synthetic=true,enabled=true,participants=false }={}) {
  const calls=[],state={ mode: synthetic ? 'synthetic' : 'real',access: true,lock: true,resource: true,event: true,
    reference: true,active: false,ready: true,loseAccess: false };let held=false;
  const custody={ id: flowId,state_hash: binding.stateHash,browser_verifier: binding.browserVerifier,
    operator_id: operatorId,generation_id: generationId,tenant_id: tenantId,user_id: userId,slot: 'northwind',
    selected_role: 'conference_manager',user_security_version: 3,current_roles: ['conference_manager'],
    operation_hash: syntheticHandoffOperationHash(syntheticScope,selection,binding) };
  const result=(present,rows=[])=>({ rowCount: present ? 1 : 0,rows: present ? rows : [] });
  const client={ async query(value) {
    calls.push(value);
    if (value?.name==='protected-calendar-current-tenant') return result(state.mode!==null,[{ mode: state.mode }]);
    if (value?.name==='synthetic-customer-session-custody') return result(state.access,[{ id: flowId }]);
    if (value?.name==='synthetic-customer-current-custody') return result(state.access,[custody]);
    if (value?.name==='protected-customer-current-invited-access') return result(state.access,[{ roles: ['conference_manager'],
      mode: state.mode,generation_id: generationId,operator_id: operatorId,slot: 'northwind' }]);
    if (value?.name==='protected-delivery-real-tenant-lock') return result(state.mode==='real');
    if (value?.name==='protected-participant-principal-member') return result(state.access,[{ id: flowId }]);
    if (value?.name==='protected-synthetic-participant-scope') return result(true,[{ allowed: state.access }]);
    if (value?.name==='protected-participant-current-session-lock') {
      if (state.loseAccess) state.access=false;return result(state.lock,[{ id: userId }]);
    }
    if (value?.name==='protected-calendar-source-lock') {
      if (state.loseAccess) state.access=false;return result(true,[{ allowed: state.lock }]);
    }
    if (value?.name==='protected-calendar-real-customer-lock') return result(state.lock,[{ id: userId }]);
    if (value?.name==='protected-calendar-booking-integration') return result(state.resource,[{ id: authority.integrationId }]);
    if (value?.name==='protected-calendar-final-synthetic-resource') return result(state.resource,[{ room_id: 'room-01' }]);
    if (value?.name==='protected-calendar-final-synthetic-event') return result(state.event,[{ id: randomUUID() }]);
    if (value?.name==='protected-calendar-final-synthetic-no-event') return result(state.active,[{ id: randomUUID() }]);
    if (value?.name==='calendar-authority-lock-current') return result(state.resource,[{}]);
    if (value?.name==='calendar-authority-lock-active-booking-reference') return result(state.reference,[{}]);
    if (value?.name==='calendar-authority-lock-write-disabled-booking-references') return { rowCount: 0,rows: [] };
    return { rowCount: 0,rows: [] };
  },release() { held=false; } };
  const pool={ query(sql) { assert.match(sql,/has_function_privilege/);return Promise.resolve({ rows: [{ allowed: state.ready }] }); },
    async connect() { assert.equal(held,false,'max1 business connection must be joined');held=true;return client; } };
  const leasePool={ query() { assert.fail('UNBOUND_LEASE_QUERY'); },async connect() {
    return { async query() { return { rowCount: 1,rows: [{ acquired: true }] }; },release() {} };
  } };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...scope,pool,leasePool });
  const guard=createPostgresProtectedCalendarAuthorityGuard(pool,
    { ...scope,syntheticScope: enabled ? syntheticScope : null,syntheticParticipantsEnabled: participants });
  const input={ tenantId,requestId: currentRequest.id,principal: principal(synthetic && !participants),authority,currentRequest };
  const run=(work)=>scopes.withShared(()=>withPostgresTransaction(pool,()=>work(client),{ isolationLevel: 'REPEATABLE READ' }));
  return { state,calls,pool,client,guard,input,run };
}

test('final synthetic authority joins max1 RR and retains full current access around the narrow source lock',async()=>{
  const f=fixture();assert.equal(await f.guard.isReady(),true);
  assert.equal(await f.run(client=>f.guard.lockCurrent(client,f.input)),true);
  const source=f.calls.find(value=>value?.name==='protected-calendar-source-lock');
  assert.deepEqual(source.values,[scope.environment,scope.securityEpoch,f.input.principal.session.id]);
  assert.equal(f.calls.filter(value=>value?.name==='synthetic-customer-current-custody').length,2);
  const event=f.calls.find(value=>value?.name==='protected-calendar-final-synthetic-event');
  assert.deepEqual(event.values.slice(6,9),[currentRequest.id,currentRequest.startsAt,currentRequest.endsAt]);
  assert.equal(f.calls.some(value=>value?.name==='calendar-authority-lock-current'),false);
});

test('stale source, recheck, event, resource or reference cannot become a confirmed synthetic booking',async()=>{
  for (const change of [{ access: false },{ lock: false },{ loseAccess: true },{ resource: false },{ event: false },{ reference: false }]) {
    const f=fixture();Object.assign(f.state,change);assert.equal(await f.run(client=>f.guard.lockCurrent(client,f.input)),false);
  }
  const f=fixture();f.state.ready=false;assert.equal(await f.guard.isReady(),false);
});

test('current registry fixes mode and no missing SYN branch or foreign principal can fall back to Microsoft',async()=>{
  for (const mode of [null,'unknown']) {
    const f=fixture();f.state.mode=mode;assert.equal(await f.run(client=>f.guard.lockCurrent(client,f.input)),false);
  }
  const absent=fixture({ enabled: false });assert.equal(await absent.run(client=>absent.guard.lockCurrent(client,absent.input)),false);
  assert.equal(absent.calls.some(value=>value?.name==='calendar-authority-lock-current'),false);
  const f=fixture();assert.equal(await f.run(client=>f.guard.lockCurrent(client,{ ...f.input,
    principal: { ...f.input.principal,tenantId: randomUUID() } })),false);
  assert.equal(f.calls.some(value=>value?.name==='protected-calendar-current-tenant'),false);
});

test('disabled calendar write requires actual absence of active synthetic events and canonical reference cleanup',async()=>{
  const f=fixture(),input={ ...f.input,authority: { ...authority,calendarWriteEnabled: false } };
  assert.equal(await f.run(client=>f.guard.lockCurrent(client,input)),true);
  f.state.active=true;assert.equal(await f.run(client=>f.guard.lockCurrent(client,input)),false);
  assert.equal(await f.run(client=>f.guard.lockCurrent(client,{ ...input,authority: { ...input.authority,
    providerResourceReference: 'foreign-room' } })),false);
});

test('protected REAL final writes retain invited session custody and the canonical Microsoft guard',async()=>{
  const f=fixture({ synthetic: false,enabled: false });
  const input={ ...f.input,authority: { ...authority,integrationProvider: 'microsoft365',identityProvider: 'microsoft_entra',
    providerConnectionReference: 'real-directory',providerResourceReference: 'real-room@example.test' } };
  assert.equal(await f.run(client=>f.guard.lockCurrent(client,input)),true);
  f.state.lock=false;assert.equal(await f.run(client=>f.guard.lockCurrent(client,input)),false);
});

test('mutation fencing requires the live exact shared transaction and current principal; PROD cannot compose SYN custody',async()=>{
  const f=fixture();
  await assert.rejects(f.guard.lockCustomerMutation(f.client,{ tenantId,principal: f.input.principal }),
    { code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  assert.equal(f.calls.length,0);
  assert.equal(await f.run(client=>f.guard.lockCustomerMutation(client,{ tenantId,principal: f.input.principal })),true);
  f.state.lock=false;
  assert.equal(await f.run(client=>f.guard.lockCustomerMutation(client,{ tenantId,principal: f.input.principal })),false);
  assert.throws(()=>createPostgresProtectedCalendarAuthorityGuard(f.pool,{ ...scope,environment: 'prod',syntheticScope }),
    /SYNTHETIC_HANDOFF_INVALID|CONFIGURATION_INVALID/);
});


test('pending booking references require current canonical synthetic custody and truthful active integration',async()=>{
  const f=fixture(),input={ tenantId,integrationId: authority.integrationId,principal: f.input.principal,
    providerConnectionReference: authority.providerConnectionReference };
  assert.equal(await f.run(client=>f.guard.lockBookingIntegration(client,input)),true);
  f.state.lock=false;assert.equal(await f.run(client=>f.guard.lockBookingIntegration(client,input)),false);
  f.state.lock=true;assert.equal(await f.run(client=>f.guard.lockBookingIntegration(client,
    { ...input,providerConnectionReference: `synthetic:${randomUUID()}` })),false);
  f.state.resource=false;assert.equal(await f.run(client=>f.guard.lockBookingIntegration(client,input)),false);
  const real=fixture({ synthetic: false });
  assert.equal(await real.run(client=>real.guard.lockBookingIntegration(client,{ ...input,principal: real.input.principal })),false);
});


test('explicit human participants fence final synthetic writes with their current member and ordinary session',async()=>{
  for (const provider of ['email_code','microsoft_entra']) {
    const f=fixture({ participants: true });f.input.principal.providerIdentity.provider=provider;
    assert.equal(await f.run(client=>f.guard.lockCurrent(client,f.input)),true);
    assert.equal(await f.run(client=>f.guard.lockBookingIntegration(client,{ tenantId,
      integrationId: authority.integrationId,providerConnectionReference: authority.providerConnectionReference,
      principal: f.input.principal })),true);
    assert.equal(f.calls.some(value=>value?.name==='synthetic-customer-session-custody'),false);
    assert.equal(f.calls.some(value=>value?.name==='protected-calendar-source-lock'),false);
    const lock=f.calls.find(value=>value?.name==='protected-participant-current-session-lock');
    assert.deepEqual(lock.values,[tenantId,userId,3,f.input.principal.session.id]);
    assert.equal(f.calls.some(value=>value?.name==='calendar-authority-lock-current'),false);
  }
  for (const change of [{ access: false },{ lock: false },{ loseAccess: true },{ resource: false },{ event: false }]) {
    const f=fixture({ participants: true });Object.assign(f.state,change);
    assert.equal(await f.run(client=>f.guard.lockCurrent(client,f.input)),false);
  }
  const strict=fixture();strict.input.principal=principal(false);
  assert.equal(await strict.run(client=>strict.guard.lockCurrent(client,strict.input)),false);
});

test('participant calendar selection is a closed boolean and requires the owned synthetic configuration',()=>{
  const f=fixture();
  for (const syntheticParticipantsEnabled of [null,'true',1,{},[]]) assert.throws(()=>
    createPostgresProtectedCalendarAuthorityGuard(f.pool,{ ...scope,syntheticScope,syntheticParticipantsEnabled }),/CONFIGURATION_INVALID/);
  assert.throws(()=>createPostgresProtectedCalendarAuthorityGuard(f.pool,{ ...scope,syntheticParticipantsEnabled: true }),
    /CONFIGURATION_INVALID/);
});

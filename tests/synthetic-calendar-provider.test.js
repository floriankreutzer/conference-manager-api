import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSyntheticCalendarProviderFactory } from '../src/integrations/synthetic-calendar-provider.js';
import { createPostgresSyntheticCalendarRepository } from '../src/persistence/postgres/synthetic-calendar-repository.js';
import { createRoomAvailabilityService } from '../src/application/room-availability-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { syntheticCalendarMetadata } from '../src/domain/synthetic-calendar.js';

const binding={ tenantId: randomUUID(),roomId: 'room-01',integrationId: randomUUID(),generationId: randomUUID() };
const metadata=syntheticCalendarMetadata(binding),eventId=randomUUID(),reference=`synthetic-event:${eventId}`;
const input={ tenantId: binding.tenantId,roomId: binding.roomId,requestId: 'request-01',
  startsAt: '2028-01-01T10:00:00.000Z',endsAt: '2028-01-01T11:00:00.000Z',phase: 'final',correlationId: randomUUID() };
function fixture() {
  const calls=[],state={ binding,availability: { available: true,conflictCount: 0 },create: {
    providerReference: reference,providerResourceReference: metadata.providerResourceReference,disposition: 'created' } };
  const repository={ async findBinding(value) { calls.push(['bind',value]);return state.binding; },
    async lookupAvailability(bound,value) { calls.push(['availability',bound,value]);return state.availability; },
    async createEvent(bound,value) { calls.push(['create',bound,value]);return state.create; },
    async updateEvent(bound,value) { calls.push(['update',bound,value]);return { providerReference: reference,disposition: 'updated' }; },
    async cancelEvent(bound,value) { calls.push(['cancel',bound,value]);
      return { providerReference: reference,disposition: 'cancelled' }; } };
  return { calls,state,repository,factory: createSyntheticCalendarProviderFactory({ repository }) };
}
const select=f=>f.factory.forRoom({ tenantId: binding.tenantId,roomId: binding.roomId });
const creating=()=>({ ...input,idempotencyKey: 'a'.repeat(64),providerResourceReference: metadata.providerResourceReference });
const changing=()=>({ ...input,providerReference: reference,providerResourceReference: metadata.providerResourceReference });

test('synthetic provider uses truthful captured bindings and canonical results for all five calendar methods',async()=>{
  const f=fixture(),provider=await select(f);assert.ok(Object.isFrozen(provider));
  for (const [key,value] of Object.entries(metadata)) assert.equal(provider[key],value);
  assert.deepEqual(await provider.lookupAvailability(input),{ available: true,conflictCount: 0 });
  f.state.availability={ available: false,conflictCount: 1 };
  assert.deepEqual(await provider.validateReservation(input),{ valid: false,reason: 'conflict' });
  assert.deepEqual(await provider.createCalendarEvent(creating()),f.state.create);
  assert.deepEqual(await provider.updateCalendarEvent(changing()),{ providerReference: reference,disposition: 'updated' });
  assert.deepEqual(await provider.cancelCalendarEvent(changing()),{ providerReference: reference,disposition: 'cancelled' });
  for (const [,bound,value] of f.calls.filter(row=>row[0]!=='bind')) {
    assert.ok(Object.isFrozen(bound));assert.ok(Object.isFrozen(value));assert.equal(bound.tenantId,binding.tenantId);
    assert.equal(value.requestId,input.requestId);assert.equal(Object.hasOwn(value,'providerResourceReference'),false);
  }
  const persisted=await f.factory.forPersistedReference({ tenantId: binding.tenantId,roomId: binding.roomId,
    integrationId: binding.integrationId,providerConnectionReference: metadata.providerConnectionReference,
    providerResourceReference: metadata.providerResourceReference });assert.equal(persisted.integrationProvider,'synthetic_calendar');
});

test('unknown, inherited and accessor construction/selection inputs cannot select hidden authority or run a getter',async()=>{
  const f=fixture();let getters=0;
  for (const config of [{},Object.create({ repository: f.repository }),{ repository: f.repository,fallback: {} },
    { get repository() { getters++;return f.repository; } }]) {
    assert.throws(()=>createSyntheticCalendarProviderFactory(config),/REPOSITORY_REQUIRED/);
  }
  const getter=Object.defineProperty({ ...f.repository },'lookupAvailability',{ get() { getters++;return ()=>{}; } });
  assert.throws(()=>createSyntheticCalendarProviderFactory({ repository: getter }),/REPOSITORY_REQUIRED/);
  for (const bad of [{ tenantId: binding.tenantId,roomId: binding.roomId,mode: 'real' },
    Object.create({ tenantId: binding.tenantId,roomId: binding.roomId }),
    { get tenantId() { getters++;return binding.tenantId; },roomId: binding.roomId }]) {
    await assert.rejects(f.factory.forRoom(bad),{ name: 'CalendarProviderError',kind: 'validation' });
  }
  assert.equal(getters,0);assert.equal(f.calls.length,0);
});

test('foreign and missing current bindings and persisted references fail without another provider or operation attempt',async()=>{
  const f=fixture();
  for (const value of [null,{ ...binding,tenantId: randomUUID() },{ ...binding,roomId: 'foreign-room' }]) {
    f.state.binding=value;await assert.rejects(select(f),{ name: 'CalendarProviderError',kind: 'authorization' });
  }
  f.state.binding=binding;
  for (const changed of [{ integrationId: randomUUID() },{ providerConnectionReference: 'microsoft:foreign' },
    { providerResourceReference: 'foreign@example.test' }]) {
    await assert.rejects(f.factory.forPersistedReference({ tenantId: binding.tenantId,roomId: binding.roomId,
      integrationId: binding.integrationId,providerConnectionReference: metadata.providerConnectionReference,
      providerResourceReference: metadata.providerResourceReference,...changed }),{ name: 'CalendarProviderError',kind: 'authorization' });
  }
  assert.equal(f.calls.some(row=>row[0]!=='bind'),false);
});

test('each operation rejects cross-scope, extra and malformed values before persistence or any fallback',async()=>{
  const f=fixture(),provider=await select(f);
  for (const changed of [{ tenantId: randomUUID() },{ roomId: 'foreign-room' },{ integrationId: randomUUID() },
    { providerConnectionReference: 'foreign-connection' }]) {
    await assert.rejects(provider.lookupAvailability({ ...input,...changed }),{ name: 'CalendarProviderError',kind: 'authorization' });
  }
  for (const changed of [{ mode: 'real' },{ startsAt: '2028-01-01' },{ endsAt: input.startsAt },{ phase: 'primary' },
    { correlationId: 'invalid' },{ requestId: '../foreign' }]) {
    await assert.rejects(provider.lookupAvailability({ ...input,...changed }),{ name: 'CalendarProviderError',kind: 'validation' });
  }
  await assert.rejects(provider.createCalendarEvent({ ...creating(),idempotencyKey: 'bad' }),{ kind: 'validation' });
  await assert.rejects(provider.updateCalendarEvent({ ...changing(),providerResourceReference: 'foreign-resource' }),
    { kind: 'authorization' });
  await assert.rejects(provider.cancelCalendarEvent({ ...changing(),providerReference: 'microsoft-event' }),{ kind: 'validation' });
  assert.equal(f.calls.length,1);
});

test('malformed results and later port replacement cannot change captured provider identity',async()=>{
  const f=fixture(),provider=await select(f);
  f.repository.lookupAvailability=()=>assert.fail('REPLACED_PORT_MUST_NOT_RUN');
  assert.equal((await provider.lookupAvailability(input)).available,true);
  f.state.create={ ...f.state.create,providerResourceReference: 'foreign-resource' };
  await assert.rejects(provider.createCalendarEvent(creating()),{ kind: 'malformed_response' });
  f.state.availability={ available: true,conflictCount: 1 };
  await assert.rejects(provider.lookupAvailability(input),{ kind: 'malformed_response' });
});

test('durable repository refuses absent live scope before a database call and forbids PROD construction',async()=>{
  let calls=0;const pool={ query() { calls++; },connect() { calls++; } },scope={ environment: 'int',securityEpoch: randomUUID() };
  const repository=createPostgresSyntheticCalendarRepository(pool,scope);
  await assert.rejects(repository.findBinding({ tenantId: binding.tenantId,roomId: binding.roomId }),
    { code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  assert.throws(()=>createPostgresSyntheticCalendarRepository(pool,{ ...scope,environment: 'prod' }),/CONFIGURATION_INVALID/);
  assert.equal(calls,0);
});

test('an in-flight caller mutation cannot change the normalized update reference',async()=>{
  const f=fixture();let release,entered;
  const pending=new Promise(resolve=>{ release=resolve; }),seen=new Promise(resolve=>{ entered=resolve; });
  f.repository.updateEvent=async(_binding,value)=>{
    entered();await pending;return { providerReference: `synthetic-event:${value.eventId}`,disposition: 'updated' };
  };
  const factory=createSyntheticCalendarProviderFactory({ repository: f.repository });
  const provider=await factory.forRoom({ tenantId: binding.tenantId,roomId: binding.roomId });
  const mutable=changing(),result=provider.updateCalendarEvent(mutable);await seen;
  mutable.providerReference=`synthetic-event:${randomUUID()}`;release();
  assert.equal((await result).providerReference,reference);
});

test('actual pre-booking service reaches the synthetic provider without inventing a Request ID',async()=>{
  const f=fixture(),principal={ userId: randomUUID(),tenantId: binding.tenantId,roles: ['employee'],
    permissions: ['request:read','request:cancel'] };
  const service=createRoomAvailabilityService({ authorizationPolicy: createAuthorizationPolicy(),calendarProviderFactory: f.factory,
    repository: { async hasConflictingRequest() { return false; } },
    requestRepository: { async findByTenantIdAndId() { assert.fail('NO_EXISTING_REQUEST'); } },
    entitlementService: { async requireAccess() { return true; } } });
  const query={ roomId: binding.roomId,startsAt: input.startsAt,endsAt: input.endsAt };
  const check=()=>service.checkAvailability({ principal,tenantContext: { tenantId: binding.tenantId,status: 'active' },
    correlationId: randomUUID(),query });
  assert.deepEqual(await check(),{ available: true,conflictCount: 0 });
  f.state.availability={ available: false,conflictCount: 1 };
  assert.deepEqual(await check(),{ available: false,conflictCount: 1 });
  for (const [name,,command] of f.calls.filter(row=>row[0]==='availability')) {
    assert.equal(name,'availability');assert.equal(command.requestId,null);
  }
  const provider=await select(f);
  for (const [name,value] of [['createCalendarEvent',creating()],['updateCalendarEvent',changing()],['cancelCalendarEvent',changing()]]) {
    delete value.requestId;await assert.rejects(provider[name](value),{ kind: 'validation' });
    await assert.rejects(provider[name]({ ...value,requestId: null }),{ kind: 'validation' });
  }
  await assert.rejects(provider.lookupAvailability({ ...input,requestId: undefined }),{ kind: 'validation' });
});

test('actual resubmission service forwards only the authorized existing Request ID to the synthetic provider',async()=>{
  const f=fixture(),userId=randomUUID(),requestId=randomUUID();
  const service=createRoomAvailabilityService({ authorizationPolicy: createAuthorizationPolicy(),calendarProviderFactory: f.factory,
    repository: { async hasConflictingRequest(value) { assert.equal(value.excludeRequestId,requestId);return false; } },
    requestRepository: { async findByTenantIdAndId() {
      return { tenantId: binding.tenantId,id: requestId,requesterUserId: userId,status: 'Change Requested' };
    } },entitlementService: { async requireAccess() { return true; } } });
  await service.checkAvailability({ principal: { userId,tenantId: binding.tenantId,roles: ['employee'],
    permissions: ['request:read','request:cancel'] },tenantContext: { tenantId: binding.tenantId,status: 'active' },
  correlationId: randomUUID(),query: { roomId: binding.roomId,startsAt: input.startsAt,endsAt: input.endsAt,
    resubmissionRequestId: requestId } });
  assert.equal(f.calls.find(row=>row[0]==='availability')[2].requestId,requestId);
});

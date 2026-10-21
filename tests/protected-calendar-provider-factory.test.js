import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedCalendarProviderFactory } from '../src/integrations/protected-calendar-provider-factory.js';
import { CalendarProviderError,PROVIDER_ERROR_KIND,assertCalendarProviderFactory } from '../src/integrations/calendar-contract.js';
import { ProtectedTenantRuntimeError } from '../src/tenancy/protected-tenant-runtime.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { loadConfig } from '../src/config.js';
const TENANT='bd000000-0000-4000-8000-000000000001',EPOCH='bd000000-0000-4000-8000-000000000002';
const OTHER='bd000000-0000-4000-8000-000000000003',INTEGRATION='bd000000-0000-4000-8000-000000000004';
const requested={ tenantId: TENANT,roomId: 'room-1' },scope={ environment: 'int',securityEpoch: EPOCH };
const real={ ...scope,tenantId: TENANT,mode: 'real',generationId: null,generationState: null,operatorId: null,slot: null };
const synthetic={ ...real,mode: 'synthetic',generationId: OTHER,generationState: 'active',operatorId: OTHER,slot: 'contoso' };
const METHODS=['lookupAvailability','validateReservation','createCalendarEvent','updateCalendarEvent','cancelCalendarEvent'];
function fixture(initial=synthetic) {
  let current=initial,locked=false,inactive=false,failure=null;const bindings=[],operations=[],reads=[];
  async function run(context,work,cleanup) {
    reads.push(cleanup);assert.deepEqual(context,{ ...scope,tenantId: TENANT });
    if (failure) throw failure;locked=true;
    try { return await work(inactive && !(cleanup && current?.mode==='real') ? null : current); }
    finally { locked=false; }
  }
  const repository={ withCurrentTenantRuntime: (context,work)=>run(context,work,false),
    withCurrentTenantCleanupRuntime: (context,work)=>run(context,work,true) };
  function provider(mode) {
    return { integrationId: INTEGRATION,providerConnectionReference: `connection:${mode}`,providerResourceReference: `resource:${mode}`,
      integrationProvider: mode==='real' ? 'microsoft365' : 'synthetic_calendar',
      identityProvider: mode==='real' ? 'microsoft_entra' : 'platform_delegation',
      ...Object.fromEntries(METHODS.map(method=>[method,async argument=>{
        assert.equal(locked,true);operations.push({ mode,method,argument });return method;
      }])) };
  }
  function factory(mode) {
    const select=async input=>{ assert.equal(locked,true);bindings.push({ mode,input });return provider(mode); };
    return { forRoom: select,forPersistedReference: select };
  }
  const realFactory=factory('real'),syntheticFactory=factory('synthetic');
  const options={ ...scope,runtimeRepository: repository,realFactory,syntheticFactory };
  return { options,bindings,operations,reads,provider,setCurrent(value) { current=value; },
    setInactive(value) { inactive=value; },setFailure(value) { failure=value; } };
}

test('current synthetic custody selects only simulation and every bound attempt reacquires the fixed-mode lease',async()=>{
  const f=fixture(),factory=createProtectedCalendarProviderFactory(f.options);
  const bound=await factory.forRoom(requested);assert.equal(bound.integrationProvider,'synthetic_calendar');
  assert.ok(Object.isFrozen(bound));
  for (const method of METHODS) assert.equal(await bound[method](requested),method);
  assert.equal(f.bindings.length,1);assert.equal(f.bindings[0].mode,'synthetic');assert.equal(f.operations.length,5);
  assert.equal(f.operations.every(value=>value.mode==='synthetic'),true);assert.equal(f.reads.length,6);
  f.setCurrent(real);await assert.rejects(bound.createCalendarEvent(requested),ProtectedTenantRuntimeError);
  assert.equal(f.operations.length,5);assert.equal(f.bindings.length,1);
});

test('missing or failed REAL providers never fall back to simulation and repository failures propagate once',async()=>{
  const f=fixture(real),factory=createProtectedCalendarProviderFactory({ ...f.options,realFactory: null });
  await assert.rejects(factory.forRoom(requested),error=>error instanceof CalendarProviderError
    && error.kind===PROVIDER_ERROR_KIND.UNAVAILABLE);
  assert.equal(f.bindings.length,0);assert.equal(f.operations.length,0);
  const failed=new Error('REAL_NOT_CONFIGURED'),other=createProtectedCalendarProviderFactory({ ...f.options,realFactory: {
    async forRoom() { throw failed; },async forPersistedReference() { throw failed; },
  } });
  await assert.rejects(other.forRoom(requested),error=>error===failed);assert.equal(f.bindings.length,0);
  const lookup=new Error('REGISTRY_UNAVAILABLE');f.setFailure(lookup);
  await assert.rejects(other.forRoom(requested),error=>error===lookup);assert.equal(f.bindings.length,0);
});

test('inactive REAL cancellation keeps its separate cleanup lease while new writes and all inactive synthetic work stay closed',async()=>{
  const f=fixture(real),factory=createProtectedCalendarProviderFactory(f.options),metadata=f.provider('real');
  const selected={ ...requested,integrationId: metadata.integrationId,providerConnectionReference: metadata.providerConnectionReference,
    providerResourceReference: metadata.providerResourceReference };
  f.setInactive(true);const cleanup=await factory.forPersistedReference(selected);
  assert.equal(await cleanup.cancelCalendarEvent(selected),'cancelCalendarEvent');
  await assert.rejects(cleanup.createCalendarEvent(selected),ProtectedTenantRuntimeError);
  await assert.rejects(cleanup.updateCalendarEvent(selected),ProtectedTenantRuntimeError);
  await assert.rejects(factory.forRoom(requested),ProtectedTenantRuntimeError);
  assert.equal(f.operations.length,1);assert.equal(f.operations[0].mode,'real');
  f.setCurrent(synthetic);await assert.rejects(factory.forPersistedReference({ ...selected,
    providerConnectionReference: 'connection:synthetic',providerResourceReference: 'resource:synthetic' }),ProtectedTenantRuntimeError);
});

test('cross-Tenant/room/reference inputs, foreign/stale custody and false simulation metadata cannot invoke provider operations',async()=>{
  const f=fixture(),factory=createProtectedCalendarProviderFactory(f.options);
  const bound=await factory.forRoom(requested),reads=f.reads.length;
  await assert.rejects(factory.forRoom({ ...requested,mode: 'real' }),error=>error instanceof CalendarProviderError
    && error.kind===PROVIDER_ERROR_KIND.VALIDATION);
  await assert.rejects(factory.forRoom({ get tenantId() { return assert.fail('INPUT_GETTER'); },roomId: 'room-1' }),
    error=>error instanceof CalendarProviderError && error.kind===PROVIDER_ERROR_KIND.VALIDATION);
  for (const value of [{ ...requested,tenantId: OTHER },{ ...requested,roomId: 'room-2' },
    { ...requested,providerResourceReference: 'foreign-resource' },{ ...requested,providerConnectionReference: 'foreign-connection' }]) {
    await assert.rejects(bound.createCalendarEvent(value),error=>error instanceof CalendarProviderError
      && error.kind===PROVIDER_ERROR_KIND.AUTHORIZATION);
  }
  assert.equal(f.reads.length,reads);assert.equal(f.operations.length,0);
  for (const descriptor of [null,{ ...synthetic,securityEpoch: OTHER },{ ...synthetic,generationState: 'archived' },
    { ...real,tenantId: OTHER }]) {
    f.setCurrent(descriptor);await assert.rejects(factory.forRoom(requested),ProtectedTenantRuntimeError);
  }
  const wrong=createProtectedCalendarProviderFactory({ ...fixture().options,syntheticFactory: {
    async forRoom() { return f.provider('real'); },async forPersistedReference() { return f.provider('real'); },
  } });
  await assert.rejects(wrong.forRoom(requested),error=>error instanceof CalendarProviderError
    && error.kind===PROVIDER_ERROR_KIND.AUTHORIZATION);
});

test('provider factory contracts snapshot only two own functions, reject accessors/extra authority and cannot enable PROD simulation',
async()=>{
  const f=fixture();let selections=0;
  const original={ async forRoom(value) { selections++;return value; },async forPersistedReference(value) { return value; } };
  const fixed=assertCalendarProviderFactory(original);original.forRoom=()=>assert.fail('MUTATED_FACTORY');
  assert.equal(await fixed.forRoom(requested),requested);assert.equal(selections,1);
  assert.equal(typeof fixed.forRoom,'function');assert.ok(Object.isFrozen(fixed));
  for (const value of [null,{},async()=>f.provider('real'),{ ...original,issueSession() {} },
    { get forRoom() { return assert.fail('FACTORY_GETTER'); },forPersistedReference() {} }]) {
    assert.throws(()=>assertCalendarProviderFactory(value),/CALENDAR_PROVIDER_FACTORY_INVALID/);
  }
  assert.throws(()=>createProtectedCalendarProviderFactory({ ...f.options,environment: 'prod' }),/CONFIGURATION_INVALID/);
  assert.throws(()=>createProtectedCalendarProviderFactory({ ...f.options,syntheticFactory: f.options.realFactory }),
    /CONFIGURATION_INVALID/);
  const config=loadConfig({ NODE_ENV: 'test' });
  assert.throws(()=>createCustomerComposition({ config,persistence: null,calendarProviderFactory: f.options.syntheticFactory }),
    /CUSTOMER_CALENDAR_PERSISTENCE_REQUIRED/);
  assert.throws(()=>createCustomerComposition({ config,persistence: {},calendarProviderFactory: {} }),/CALENDAR_PROVIDER_FACTORY_INVALID/);
});


test('a duplicate registry callback cannot bind twice or replay a provider attempt',async()=>{
  const f=fixture();let bindings=0;
  const select=async()=>{ bindings++;return f.provider('synthetic'); };
  const factory=createProtectedCalendarProviderFactory({ ...f.options,syntheticFactory: {
    forRoom: select,forPersistedReference: select },runtimeRepository: {
      async withCurrentTenantRuntime(context,work) { await work(synthetic);return work(synthetic); },
      async withCurrentTenantCleanupRuntime(context,work) { return work(synthetic); },
    } });
  await assert.rejects(factory.forRoom(requested),ProtectedTenantRuntimeError);assert.equal(bindings,1);
  assert.equal(f.operations.length,0);
});

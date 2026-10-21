import { isInternalUuid } from '../domain/identifiers.js';
import { createProtectedTenantProviderGate } from '../tenancy/protected-tenant-provider-gate.js';
import { ProtectedTenantRuntimeError,requireProtectedTenantRuntime } from '../tenancy/protected-tenant-runtime.js';
import { assertCalendarProvider,assertCalendarProviderFactory,CalendarProviderError,PROVIDER_ERROR_KIND,
  isCalendarRoomId,isProviderConnectionReference,isProviderResourceReference } from './calendar-contract.js';

const METHODS=['lookupAvailability','validateReservation','createCalendarEvent','updateCalendarEvent','cancelCalendarEvent'];
const FIELDS=['integrationId','integrationProvider','identityProvider','providerConnectionReference','providerResourceReference'];
const fail=kind=>{ throw new CalendarProviderError(kind,{ operation: 'provider_selection' }); };
function own(value,key) {
  const property=value && Object.getOwnPropertyDescriptor(value,key);
  return property && Object.hasOwn(property,'value') ? property.value : undefined;
}
function input(value,persisted) {
  const keys=persisted ? ['tenantId','roomId','integrationId','providerConnectionReference','providerResourceReference']
    : ['tenantId','roomId'];
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length!==keys.length
    || Reflect.ownKeys(value).some(key=>!keys.includes(key) || own(value,key)===undefined)
    || !isInternalUuid(own(value,'tenantId')) || !isCalendarRoomId(own(value,'roomId'))
    || persisted && (!isInternalUuid(own(value,'integrationId')) || !isProviderConnectionReference(own(value,'providerConnectionReference'))
      || !isProviderResourceReference(own(value,'providerResourceReference')))) fail(PROVIDER_ERROR_KIND.VALIDATION);
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,own(value,key)])));
}
function boundProvider(value,requested,mode,gates) {
  if (!value || [...FIELDS,...METHODS].some(key=>own(value,key)===undefined)) fail(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE);
  assertCalendarProvider(Object.fromEntries([...FIELDS,...METHODS].map(key=>[key,own(value,key)])));
  if (own(value,'integrationProvider')!==(mode==='real' ? 'microsoft365' : 'synthetic_calendar')
    || own(value,'identityProvider')!==(mode==='real' ? 'microsoft_entra' : 'platform_delegation')) {
    fail(PROVIDER_ERROR_KIND.AUTHORIZATION);
  }
  if (requested.integrationId!==undefined && ['integrationId','providerConnectionReference','providerResourceReference']
    .some(key=>own(value,key)!==requested[key])) fail(PROVIDER_ERROR_KIND.AUTHORIZATION);
  const metadata=Object.fromEntries(FIELDS.map(key=>[key,own(value,key)]));
  return Object.freeze({ ...metadata,...Object.fromEntries(METHODS.map(method=>{
    const operation=own(value,method);if (typeof operation!=='function') fail(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE);
    return [method,async argument=>{
      if (!argument || own(argument,'tenantId')!==requested.tenantId || own(argument,'roomId')!==requested.roomId
        || Object.hasOwn(argument,'integrationId') && own(argument,'integrationId')!==metadata.integrationId
        || Object.hasOwn(argument,'providerConnectionReference')
          && own(argument,'providerConnectionReference')!==metadata.providerConnectionReference
        || Object.hasOwn(argument,'providerResourceReference')
          && own(argument,'providerResourceReference')!==metadata.providerResourceReference) fail(PROVIDER_ERROR_KIND.AUTHORIZATION);
      // Only cancellation can retain REAL cleanup after suspension/archive.
      // All synthetic work and every new/updated reservation require active custody.
      const gate=method==='cancelCalendarEvent' ? gates.cleanup[mode] : gates.active[mode];
      return gate.run(requested.tenantId,()=>operation.call(value,argument));
    }];
  })) });
}

// Runtime mode comes from current owned registry custody, never a caller mode,
// provider reference, browser flag or failed-REAL fallback. The returned adapter
// rechecks its captured mode under the retained lease on every provider attempt.
export function createProtectedCalendarProviderFactory({ runtimeRepository,environment,securityEpoch,
  realFactory=null,syntheticFactory=null }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)
    || typeof runtimeRepository?.withCurrentTenantRuntime!=='function'
    || typeof runtimeRepository?.withCurrentTenantCleanupRuntime!=='function'
    || environment==='prod' && syntheticFactory!==null || realFactory!==null && realFactory===syntheticFactory) {
    throw new TypeError('PROTECTED_CALENDAR_FACTORY_CONFIGURATION_INVALID');
  }
  const scope={ environment,securityEpoch },factories={
    real: realFactory===null ? null : assertCalendarProviderFactory(realFactory),
    synthetic: syntheticFactory===null ? null : assertCalendarProviderFactory(syntheticFactory),
  };
  const cleanupRepository={
    withCurrentTenantRuntime: (context,work)=>runtimeRepository.withCurrentTenantCleanupRuntime(context,work) };
  const active={ real: createProtectedTenantProviderGate({ ...scope,repository: runtimeRepository,mode: 'real' }),
    synthetic: environment==='prod' ? null
      : createProtectedTenantProviderGate({ ...scope,repository: runtimeRepository,mode: 'synthetic' }) };
  const cleanup={ real: createProtectedTenantProviderGate({ ...scope,repository: cleanupRepository,mode: 'real' }),
    synthetic: active.synthetic };
  async function select(value,persisted) {
    const requested=input(value,persisted),context={ ...scope,tenantId: requested.tenantId };let invoked=false;
    const read=persisted ? runtimeRepository.withCurrentTenantCleanupRuntime : runtimeRepository.withCurrentTenantRuntime;
    return read.call(runtimeRepository,context,async descriptor=>{
      if (invoked) throw new ProtectedTenantRuntimeError();invoked=true;
      const runtime=requireProtectedTenantRuntime(context,descriptor),factory=factories[runtime.mode];
      if (factory===null) fail(PROVIDER_ERROR_KIND.UNAVAILABLE);
      const provider=await factory[persisted ? 'forPersistedReference' : 'forRoom'](requested);
      return boundProvider(provider,requested,runtime.mode,{ active,cleanup });
    });
  }
  return Object.freeze({ forRoom: value=>select(value,false),forPersistedReference: value=>select(value,true) });
}

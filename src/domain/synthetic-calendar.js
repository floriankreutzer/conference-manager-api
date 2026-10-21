import { isInternalUuid } from './identifiers.js';
import { isRequestId } from './request.js';
import { isCalendarRoomId,isIdempotencyKey,isReservationPhase } from './calendar-values.js';

export class SyntheticCalendarValueError extends Error {
  constructor(kind) { super('SYNTHETIC_CALENDAR_VALUE_INVALID');this.name='SyntheticCalendarValueError';this.kind=kind; }
}
function fail(kind='validation') { throw new SyntheticCalendarValueError(kind); }
function record(value,required,optional=[]) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || required.some(key=>!Object.hasOwn(value,key)) || Reflect.ownKeys(value).some(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key);
      return ![...required,...optional].includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
    })) fail();
}
function uuid(value) { if (!isInternalUuid(value)) fail();return value.toLowerCase(); }
function instant(value) {
  if (typeof value!=='string' || value.length!==24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString()!==value) fail();return value;
}
export function normalizeSyntheticCalendarBinding(value) {
  record(value,['tenantId','roomId','integrationId','generationId']);
  if (!isCalendarRoomId(value.roomId)) fail();
  return Object.freeze({ tenantId: uuid(value.tenantId),roomId: value.roomId,integrationId: uuid(value.integrationId),
    generationId: uuid(value.generationId) });
}
export function syntheticCalendarMetadata(value) {
  const binding=normalizeSyntheticCalendarBinding(value);
  return Object.freeze({ integrationId: binding.integrationId,integrationProvider: 'synthetic_calendar',
    identityProvider: 'platform_delegation',providerConnectionReference: `synthetic:${binding.generationId}`,
    providerResourceReference: `synthetic-room:${binding.tenantId}:${binding.roomId}` });
}
export function normalizeSyntheticCalendarSelection(value,persisted=false) {
  record(value,['tenantId','roomId',...(persisted
    ? ['integrationId','providerConnectionReference','providerResourceReference'] : [])]);
  if (!isCalendarRoomId(value.roomId)) fail();
  const result={ tenantId: uuid(value.tenantId),roomId: value.roomId };
  if (persisted) {
    result.integrationId=uuid(value.integrationId);
    for (const key of ['providerConnectionReference','providerResourceReference']) {
      if (typeof value[key]!=='string' || value[key].length>320) fail();result[key]=value[key];
    }
  }
  return Object.freeze(result);
}
export function normalizeSyntheticCalendarOperation(binding,value,operation) {
  binding=normalizeSyntheticCalendarBinding(binding);
  if (!['availability','create','update','cancel'].includes(operation)) fail();
  const required=['tenantId','roomId','requestId','startsAt','endsAt','phase','correlationId',
    ...(operation==='create' ? ['idempotencyKey','providerResourceReference'] : []),
    ...(['update','cancel'].includes(operation) ? ['providerReference','providerResourceReference'] : [])];
  record(value,required,['integrationId','providerConnectionReference']);
  const metadata=syntheticCalendarMetadata(binding);
  if (uuid(value.tenantId)!==binding.tenantId || value.roomId!==binding.roomId
    || Object.hasOwn(value,'integrationId') && uuid(value.integrationId)!==metadata.integrationId
    || Object.hasOwn(value,'providerConnectionReference') && value.providerConnectionReference!==metadata.providerConnectionReference
    || Object.hasOwn(value,'providerResourceReference') && value.providerResourceReference!==metadata.providerResourceReference) {
    fail('authorization');
  }
  if (!isRequestId(value.requestId) || !isReservationPhase(value.phase)) fail();
  const startsAt=instant(value.startsAt),endsAt=instant(value.endsAt),duration=Date.parse(endsAt)-Date.parse(startsAt);
  if (duration<=0 || duration>366*86400000) fail();
  const result={ tenantId: binding.tenantId,roomId: binding.roomId,requestId: value.requestId,startsAt,endsAt,
    phase: value.phase,correlationId: uuid(value.correlationId) };
  if (operation==='create') { if (!isIdempotencyKey(value.idempotencyKey)) fail();result.idempotencyKey=value.idempotencyKey; }
  if (['update','cancel'].includes(operation)) {
    if (typeof value.providerReference!=='string' || !value.providerReference.startsWith('synthetic-event:')) fail();
    result.eventId=uuid(value.providerReference.slice('synthetic-event:'.length));
  }
  return Object.freeze(result);
}

// Infrastructure receives this closed normalized command, never raw HTTP data.
export function normalizeSyntheticCalendarCommand(binding,value,operation) {
  record(value,['tenantId','roomId','requestId','startsAt','endsAt','phase','correlationId',
    ...(operation==='create' ? ['idempotencyKey'] : []),...(['update','cancel'].includes(operation) ? ['eventId'] : [])]);
  const raw={ ...value };
  if (operation!=='availability') raw.providerResourceReference=syntheticCalendarMetadata(binding).providerResourceReference;
  if (['update','cancel'].includes(operation)) {
    raw.providerReference=`synthetic-event:${uuid(raw.eventId)}`;delete raw.eventId;
  }
  return normalizeSyntheticCalendarOperation(binding,raw,operation);
}

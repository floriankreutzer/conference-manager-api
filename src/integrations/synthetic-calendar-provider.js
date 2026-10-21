import { CalendarProviderError,PROVIDER_ERROR_KIND,normalizeAvailabilityResult,normalizeCreateResult,
  normalizeUpdateResult,normalizeCancelResult } from './calendar-contract.js';
import { SyntheticCalendarValueError,normalizeSyntheticCalendarBinding,normalizeSyntheticCalendarSelection,
  normalizeSyntheticCalendarOperation,
  syntheticCalendarMetadata } from '../domain/synthetic-calendar.js';

function values(work) {
  try { return work(); } catch (error) {
    if (error instanceof SyntheticCalendarValueError) {
      throw new CalendarProviderError(error.kind,{ operation: 'synthetic_calendar' });
    }
    throw error;
  }
}

// This adapter has no network, Microsoft, mail, Demo, clock, credential or
// arbitrary outbound/provider port. The owned root supplies its private store.
export function createSyntheticCalendarProviderFactory(configuration={}) {
  const entry=Object.getOwnPropertyDescriptor(configuration,'repository');
  if (![Object.prototype,null].includes(Object.getPrototypeOf(configuration)) || Reflect.ownKeys(configuration).length!==1
    || !entry || !Object.hasOwn(entry,'value')) throw new TypeError('SYNTHETIC_CALENDAR_REPOSITORY_REQUIRED');
  const repository=entry.value;
  const names=['findBinding','lookupAvailability','createEvent','updateEvent','cancelEvent'];
  if (!repository || ![Object.prototype,null].includes(Object.getPrototypeOf(repository))
    || Reflect.ownKeys(repository).length!==names.length || names.some(name=>{
      const field=Object.getOwnPropertyDescriptor(repository,name);
      return !field || !Object.hasOwn(field,'value') || typeof field.value!=='function';
    })) throw new TypeError('SYNTHETIC_CALENDAR_REPOSITORY_REQUIRED');
  const methods=Object.freeze(Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(repository,name)
    .value.bind(repository)])));
  async function select(input,persisted) {
    const selection=values(()=>normalizeSyntheticCalendarSelection(input,persisted));
    const found=await methods.findBinding({
      tenantId: selection.tenantId,roomId: selection.roomId });
    if (!found) throw new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION,{ operation: 'provider_selection' });
    const binding=values(()=>normalizeSyntheticCalendarBinding(found)),metadata=syntheticCalendarMetadata(binding);
    if (binding.tenantId!==selection.tenantId || binding.roomId!==selection.roomId || persisted
      && ['integrationId','providerConnectionReference','providerResourceReference'].some(key=>metadata[key]!==selection[key])) {
      throw new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION,{ operation: 'provider_selection' });
    }
    const operation=(input,name)=>values(()=>normalizeSyntheticCalendarOperation(binding,input,name));
    return Object.freeze({ ...metadata,
      async lookupAvailability(input) {
        return normalizeAvailabilityResult(await methods.lookupAvailability(binding,operation(input,'availability')));
      },
      async validateReservation(input) {
        const result=normalizeAvailabilityResult(await methods.lookupAvailability(binding,operation(input,'availability')));
        return Object.freeze({ valid: result.available,reason: result.available ? 'available' : 'conflict' });
      },
      async createCalendarEvent(input) {
        const result=normalizeCreateResult(await methods.createEvent(binding,operation(input,'create')));
        if (result.providerResourceReference!==metadata.providerResourceReference) {
          throw new CalendarProviderError(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE,{ operation: 'create' });
        }
        return result;
      },
      async updateCalendarEvent(input) {
        const command=operation(input,'update');
        return normalizeUpdateResult(await methods.updateEvent(binding,command),`synthetic-event:${command.eventId}`);
      },
      async cancelCalendarEvent(input) {
        const command=operation(input,'cancel');
        return normalizeCancelResult(await methods.cancelEvent(binding,command),`synthetic-event:${command.eventId}`);
      },
    });
  }
  return Object.freeze({ forRoom: value=>select(value,false),forPersistedReference: value=>select(value,true) });
}

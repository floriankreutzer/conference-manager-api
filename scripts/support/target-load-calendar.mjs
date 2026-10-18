import { createHash } from 'node:crypto';
import { isInternalUuid } from '../../src/domain/identifiers.js';

// An explicit in-process external boundary: no Graph/identity credential or network.
// Canonical connection/mapping/authority, health, booking and audit services still run.
export function createTargetLoadCalendar(bindings) {
  if (!(bindings instanceof Map) || bindings.size !== 10) throw new Error('LOAD_CALENDAR_BINDINGS_INVALID');
  bindings = new Map([...bindings].map(([reference, record]) => {
    if (!isInternalUuid(reference)
      || typeof record?.address !== 'string' || !/^room[0-9]@synthetic\.invalid$/.test(record.address)) {
      throw new Error('LOAD_CALENDAR_BINDINGS_INVALID');
    }
    return [reference, Object.freeze({ address: record.address })];
  }));
  if (new Set([...bindings.values()].map(record => record.address)).size !== 10
    || new Set([...bindings.keys()].map(reference => reference.toLowerCase())).size !== 10) {
    throw new Error('LOAD_CALENDAR_BINDINGS_INVALID');
  }
  const events = new Map(); const calls = { availability: 0, create: 0, update: 0, cancel: 0 };
  function binding(tenantReference, resourceAddress) {
    const record = bindings.get(tenantReference);
    if (!record || record.address !== resourceAddress) throw new Error('LOAD_CALENDAR_SCOPE_INVALID');
    return record;
  }
  function slot(startsAt, endsAt) {
    const start = Date.parse(startsAt); const end = Date.parse(endsAt);
    if (typeof startsAt !== 'string' || typeof endsAt !== 'string'
      || !Number.isFinite(start) || !Number.isFinite(end)
      || new Date(start).toISOString() !== startsAt || new Date(end).toISOString() !== endsAt
      || end <= start || end - start > 86400000) {
      throw new Error('LOAD_CALENDAR_SLOT_INVALID');
    }
    return { start, end };
  }
  function forbidden() { throw new Error('LOAD_PROVIDER_OPERATION_FORBIDDEN'); }
  const client = Object.freeze({
    async lookupFreeBusy({ tenantReference, schedules, startsAt, endsAt }) {
      if (!Array.isArray(schedules) || schedules.length !== 1) throw new Error('LOAD_CALENDAR_SCOPE_INVALID');
      binding(tenantReference, schedules[0]); const range = slot(startsAt, endsAt); calls.availability += 1;
      const count = [...events.values()].filter(event => event.tenantReference === tenantReference
        && event.resourceAddress === schedules[0] && event.start < range.end && event.end > range.start).length;
      return [{ schedule: schedules[0], available: count === 0, conflictCount: count }];
    },
    async createCalendarEvent({ tenantReference, resourceAddress, startsAt, endsAt, idempotencyKey }) {
      binding(tenantReference, resourceAddress); const range = slot(startsAt, endsAt);
      if (typeof idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/.test(idempotencyKey)
        || (!events.has(idempotencyKey) && events.size >= 1000)) throw new Error('LOAD_CALENDAR_BOUNDS_INVALID');
      calls.create += 1;
      const existing = events.get(idempotencyKey);
      if (existing && (existing.tenantReference !== tenantReference || existing.resourceAddress !== resourceAddress
        || existing.start !== range.start || existing.end !== range.end)) throw new Error('LOAD_CALENDAR_IDEMPOTENCY_INVALID');
      const providerReference = `fixture-${createHash('sha256').update(idempotencyKey).digest('hex')}`;
      events.set(idempotencyKey, { tenantReference, resourceAddress, ...range, providerReference });
      return { providerReference, disposition: existing ? 'existing' : 'created' };
    },
    updateCalendarEvent: forbidden,
    cancelCalendarEvent: forbidden,
    verifyBasePermissions: forbidden,
    adminConsentUrl: forbidden,
    discoverRooms: forbidden,
  });
  return Object.freeze({ client, snapshot: () => Object.freeze({ ...calls, uniqueEvents: events.size }) });
}

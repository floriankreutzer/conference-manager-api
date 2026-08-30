import {
  MICROSOFT365_VERIFICATION,
  Microsoft365ProviderError,
} from '../../integrations/microsoft365-contract.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const RESOURCE_PATTERN = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCENARIOS = new Set(['booking_success', 'transient_conflict', 'provider_degraded']);

function invalid(code) {
  throw new Microsoft365ProviderError(code);
}

function tenantReference(value) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    invalid('MICROSOFT365_TENANT_INVALID');
  }
  return value.toLowerCase();
}

function resourceAddress(value) {
  if (typeof value !== 'string' || !RESOURCE_PATTERN.test(value)) {
    invalid('MICROSOFT365_GRAPH_REQUEST_INVALID');
  }
  return value.toLowerCase();
}

function instant(value) {
  if (
    typeof value !== 'string'
    || !UTC_INSTANT_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
  ) invalid('MICROSOFT365_GRAPH_REQUEST_INVALID');
  return value;
}

function timeWindow(startsAt, endsAt) {
  const start = instant(startsAt);
  const end = instant(endsAt);
  if (Date.parse(end) <= Date.parse(start)) invalid('MICROSOFT365_GRAPH_REQUEST_INVALID');
  return Object.freeze({ startsAt: start, endsAt: end });
}

function providerReference(value) {
  if (typeof value !== 'string' || !PROVIDER_REFERENCE_PATTERN.test(value)) {
    invalid('MICROSOFT365_CALENDAR_REFERENCE_INVALID');
  }
  return value;
}

function normalizedRooms(value) {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('DEMO_PROVIDER_ROOMS_INVALID');
  return Object.freeze(value.map((room) => {
    if (
      !room
      || typeof room !== 'object'
      || Array.isArray(room)
      || typeof room.id !== 'string'
      || !PROVIDER_REFERENCE_PATTERN.test(room.id)
      || typeof room.displayName !== 'string'
      || room.displayName.length < 1
      || room.displayName.length > 160
      || !Number.isSafeInteger(room.capacity)
      || room.capacity < 1
      || room.capacity > 100_000
    ) throw new TypeError('DEMO_PROVIDER_ROOMS_INVALID');
    const address = resourceAddress(room.resourceAddress);
    return Object.freeze({
      externalRoomId: room.id,
      displayName: room.displayName,
      resourceAddress: address,
      capacity: room.capacity,
      building: room.building ?? null,
      floorNumber: room.floorNumber ?? null,
      floorLabel: null,
      label: null,
      nickname: null,
      phone: null,
      audioDeviceName: null,
      videoDeviceName: null,
      displayDeviceName: null,
      bookingType: null,
    });
  }));
}

export function createDemoMicrosoft365Client({
  publicOrigin,
  roomsByTenantReference = Object.freeze({}),
  scenarioByTenantReference = Object.freeze({}),
} = {}) {
  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new TypeError('DEMO_PROVIDER_ORIGIN_INVALID');
  }
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) {
    throw new TypeError('DEMO_PROVIDER_ORIGIN_INVALID');
  }

  const rooms = new Map(Object.entries(roomsByTenantReference).map(([key, value]) => [
    tenantReference(key),
    normalizedRooms(value),
  ]));
  const scenarios = new Map(Object.entries(scenarioByTenantReference).map(([key, value]) => {
    if (!SCENARIOS.has(value)) throw new TypeError('DEMO_PROVIDER_SCENARIO_INVALID');
    return [tenantReference(key), value];
  }));

  function scenario(value) {
    return scenarios.get(tenantReference(value)) ?? 'booking_success';
  }

  function requireAvailable(value) {
    if (scenario(value) === 'provider_degraded') {
      invalid('MICROSOFT365_GRAPH_UNAVAILABLE');
    }
  }

  return Object.freeze({
    redirectUri: new URL('/api/v1/integrations/microsoft365/callback', origin).toString(),

    adminConsentUrl({ tenantReference: tenantValue, state }) {
      tenantReference(tenantValue);
      if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
        invalid('MICROSOFT365_CONSENT_STATE_INVALID');
      }
      const url = new URL('/api/v1/integrations/microsoft365/callback', origin);
      url.searchParams.set('state', state);
      url.searchParams.set('tenant', tenantReference(tenantValue));
      url.searchParams.set('admin_consent', 'true');
      return url.toString();
    },

    async verifyBasePermissions({ tenantReference: tenantValue }) {
      if (scenario(tenantValue) === 'provider_degraded') {
        return Object.freeze({
          status: MICROSOFT365_VERIFICATION.DEGRADED,
          places: 'unknown',
          calendars: 'unknown',
          reason: 'provider_unavailable',
        });
      }
      return Object.freeze({
        status: MICROSOFT365_VERIFICATION.CONNECTED,
        places: 'granted',
        calendars: 'granted',
        reason: null,
      });
    },

    async discoverRooms({ tenantReference: tenantValue }) {
      requireAvailable(tenantValue);
      return rooms.get(tenantReference(tenantValue)) ?? Object.freeze([]);
    },

    async lookupFreeBusy({ tenantReference: tenantValue, schedules, startsAt, endsAt }) {
      requireAvailable(tenantValue);
      timeWindow(startsAt, endsAt);
      if (
        !Array.isArray(schedules)
        || schedules.length < 1
        || schedules.length > 20
        || new Set(schedules.map(resourceAddress)).size !== schedules.length
      ) invalid('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
      const available = scenario(tenantValue) !== 'transient_conflict';
      return Object.freeze(schedules.map((schedule) => Object.freeze({
        schedule: resourceAddress(schedule),
        available,
        conflictCount: available ? 0 : 1,
      })));
    },

    async createCalendarEvent({
      tenantReference: tenantValue,
      resourceAddress: address,
      startsAt,
      endsAt,
      idempotencyKey,
    }) {
      requireAvailable(tenantValue);
      resourceAddress(address);
      timeWindow(startsAt, endsAt);
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        invalid('MICROSOFT365_CALENDAR_IDEMPOTENCY_INVALID');
      }
      if (scenario(tenantValue) === 'transient_conflict') {
        invalid('MICROSOFT365_CALENDAR_CONFLICT');
      }
      return Object.freeze({
        providerReference: `demo-event-${idempotencyKey.slice(0, 32)}`,
        disposition: 'created',
      });
    },

    async updateCalendarEvent({
      tenantReference: tenantValue,
      resourceAddress: address,
      providerReference: reference,
      startsAt,
      endsAt,
    }) {
      requireAvailable(tenantValue);
      resourceAddress(address);
      timeWindow(startsAt, endsAt);
      return Object.freeze({ providerReference: providerReference(reference), disposition: 'updated' });
    },

    async cancelCalendarEvent({
      tenantReference: tenantValue,
      resourceAddress: address,
      providerReference: reference,
    }) {
      requireAvailable(tenantValue);
      resourceAddress(address);
      return Object.freeze({ providerReference: providerReference(reference), disposition: 'cancelled' });
    },
  });
}

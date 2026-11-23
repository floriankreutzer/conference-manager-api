import assert from 'node:assert/strict';
import test from 'node:test';
import { createMicrosoft365BookingServiceFactory } from '../src/application/microsoft365-booking-service-factory.js';
import { createSyntheticCalendarProviderFactory } from '../src/integrations/synthetic-calendar-provider.js';
import { syntheticCalendarMetadata } from '../src/domain/synthetic-calendar.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const integrationId = '22222222-2222-4222-8222-222222222222';
const generationId = '33333333-3333-4333-8333-333333333333';
const changeId = '44444444-4444-4444-8444-444444444444';
const oldId = '55555555-5555-4555-8555-555555555555';
const targetId = '66666666-6666-4666-8666-666666666666';
const restoredId = '77777777-7777-4777-8777-777777777777';

function fixture() {
  const calls = [], events = new Map(), keys = new Map();
  const binding = roomId => ({ tenantId, integrationId, generationId, roomId });
  const oldMetadata = syntheticCalendarMetadata(binding('room-old'));
  const current = { tenantId, id: 'REQ-1', roomId: 'room-old',
    startsAt: '2026-12-01T10:00:00.000Z', endsAt: '2026-12-01T11:00:00.000Z' };
  const proposed = { ...current, roomId: 'room-new' };
  const context = { principal: {}, tenantContext: { tenantId }, phase: 'final', correlationId: changeId };
  events.set(oldId, { roomId: current.roomId, active: true });
  const repository = {
    async findBinding(value) {
      return value.tenantId === tenantId && ['room-old', 'room-new'].includes(value.roomId)
        ? binding(value.roomId) : null;
    },
    async lookupAvailability() { return { available: true, conflictCount: 0 }; },
    async createEvent(bound, command) {
      calls.push(['create', bound.roomId, command.idempotencyKey]);
      const existing = keys.get(command.idempotencyKey);
      const id = existing ?? (bound.roomId === 'room-new' ? targetId : restoredId);
      if (!existing) {
        keys.set(command.idempotencyKey, id);
        events.set(id, { roomId: bound.roomId, active: true });
      }
      return { providerReference: `synthetic-event:${id}`,
        providerResourceReference: syntheticCalendarMetadata(bound).providerResourceReference,
        disposition: existing ? 'existing' : 'created' };
    },
    async updateEvent() { assert.fail('ROOM_MOVE_MUST_NOT_UPDATE'); },
    async cancelEvent(bound, command) {
      calls.push(['cancel', bound.roomId, command.eventId]);
      const event = events.get(command.eventId);
      assert.equal(event.roomId, bound.roomId);
      const disposition = event.active ? 'cancelled' : 'already_cancelled';
      event.active = false;
      return { providerReference: `synthetic-event:${command.eventId}`, disposition };
    },
  };
  const reference = { ...oldMetadata, state: 'active', providerReference: `synthetic-event:${oldId}` };
  const service = createMicrosoft365BookingServiceFactory({
    repository: { async hasProviderReferenceByRequest() { return true; },
      async findProviderReferenceForCancellation() { return reference; } },
    calendarProviderFactory: createSyntheticCalendarProviderFactory({ repository }),
    entitlementService: { async requireAccess() {} }, auditService: {},
    authorizationPolicy: { authorizeBookingOperation() {} },
  });
  return { service, current, proposed, context, events, calls, reference };
}

test('actual synthetic adapter accepts room replacement and restoration with exact server resource bindings', async () => {
  const f = fixture();
  const moved = await f.service.moveCalendarEvent(f.context, f.current, f.proposed, changeId, 1);
  assert.equal(moved.status, 'moved');
  assert.equal(moved.replacement.providerResourceReference, `synthetic-room:${tenantId}:room-new`);
  assert.equal(f.events.get(oldId).active, false);
  assert.equal(f.events.get(targetId).active, true);
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['create', 'room-new'], ['cancel', 'room-old']]);
  const restored = await f.service.rollbackCalendarMove(
    f.context, f.current, f.proposed, changeId, 1, moved.replacement,
  );
  assert.equal(restored.providerResourceReference, f.reference.providerResourceReference);
  assert.equal(f.events.get(targetId).active, false);
  assert.equal(f.events.get(restoredId).active, true);
  assert.notEqual(restored.idempotencyKey, moved.replacement.idempotencyKey);
});

test('room replacement cannot select a foreign synthetic tenant or persisted resource', async () => {
  for (const kind of ['tenant', 'resource']) {
    const f = fixture();
    if (kind === 'tenant') f.proposed.tenantId = '88888888-8888-4888-8888-888888888888';
    else f.reference.providerResourceReference = `synthetic-room:${tenantId}:room-new`;
    await assert.rejects(f.service.moveCalendarEvent(f.context, f.current, f.proposed, changeId, 1),
      { name: 'CalendarProviderError', kind: 'authorization' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.events.get(oldId).active, true);
  }
});

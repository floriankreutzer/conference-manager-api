import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOKING_CHANGE_MOVE_RECOVERY,
  BookingChangeCalendarMoveError,
} from '../src/application/booking-change-errors.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from '../src/integrations/calendar-contract.js';
import { createMicrosoft365BookingServiceFactory } from '../src/application/microsoft365-booking-service-factory.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CHANGE_ID = '22222222-2222-4222-8222-222222222222';
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';

function request(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'REQ-1',
    roomId: 'room-old',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    ...overrides,
  };
}

function factory({ createTarget, cancelOld, cancelTarget }) {
  const reference = {
    state: 'active',
    integrationId: INTEGRATION_ID,
    providerConnectionReference: 'connection-1',
    providerReference: 'old-event',
    providerResourceReference: 'old-room@example.invalid',
  };
  const oldProvider = {
    async cancelCalendarEvent(value) {
      return await cancelOld(value) ?? {
        providerReference: value.providerReference,
        disposition: 'cancelled',
      };
    },
  };
  const targetProvider = {
    integrationId: INTEGRATION_ID,
    providerResourceReference: 'new-room@example.invalid',
    async validateReservation() { return { valid: true, reason: 'available' }; },
    async createCalendarEvent(value) {
      return { providerResourceReference: this.providerResourceReference, ...createTarget(value) };
    },
    async cancelCalendarEvent(value) {
      return await cancelTarget(value) ?? {
        providerReference: value.providerReference,
        disposition: 'cancelled',
      };
    },
  };
  return createMicrosoft365BookingServiceFactory({
    repository: {
      async hasProviderReferenceByRequest() { return true; },
      async findProviderReferenceForCancellation() { return reference; },
    },
    calendarProviderFactory: {
      async forPersistedReference() { return oldProvider; },
      async forRoom() { return targetProvider; },
    },
    entitlementService: { async requireAccess() {} },
    auditService: {},
    authorizationPolicy: { authorizeBookingOperation() { return true; } },
  });
}

function context(current) {
  return {
    principal: {},
    tenantContext: { tenantId: TENANT_ID },
    correlationId: '44444444-4444-4444-8444-444444444444',
    request: current,
    phase: 'final',
  };
}

test('room-move retry rotates its target key only after confirmed target cleanup', async () => {
  const targetKeys = [];
  let oldCancellationAttempt = 0;
  const service = factory({
    createTarget(value) {
      targetKeys.push(value.idempotencyKey);
      return {
        disposition: 'created',
        providerReference: `target-${targetKeys.length}`,
      };
    },
    cancelOld() {
      oldCancellationAttempt += 1;
      if (oldCancellationAttempt === 1) {
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.VALIDATION, {
          operation: 'cancel',
        });
      }
    },
    cancelTarget() {},
  });
  const current = request();
  const proposed = request({ roomId: 'room-new' });
  await assert.rejects(
    service.moveCalendarEvent(
      context(current), current, proposed, CHANGE_ID, 1,
    ),
    (error) => error instanceof BookingChangeCalendarMoveError
      && error.recovery === BOOKING_CHANGE_MOVE_RECOVERY.RETRY_NEW_ATTEMPT,
  );
  const moved = await service.moveCalendarEvent(
    context(current), current, proposed, CHANGE_ID, 2,
  );
  assert.equal(moved.status, 'moved');
  assert.notEqual(targetKeys[0], targetKeys[1]);
});

test('unknown target-create outcome retains the same idempotency key for applying-state resume', async () => {
  const targetKeys = [];
  const service = factory({
    createTarget(value) {
      targetKeys.push(value.idempotencyKey);
      throw new Error('UNKNOWN_CREATE_OUTCOME');
    },
    cancelOld() { throw new Error('UNEXPECTED_OLD_CANCEL'); },
    cancelTarget() { throw new Error('UNEXPECTED_TARGET_CANCEL'); },
  });
  const current = request();
  const proposed = request({ roomId: 'room-new' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      service.moveCalendarEvent(
        context(current), current, proposed, CHANGE_ID, 1,
      ),
      (error) => error instanceof BookingChangeCalendarMoveError
        && error.recovery === BOOKING_CHANGE_MOVE_RECOVERY.RETRY_SAME_ATTEMPT,
    );
  }
  assert.equal(targetKeys.length, 2);
  assert.equal(targetKeys[0], targetKeys[1]);
});

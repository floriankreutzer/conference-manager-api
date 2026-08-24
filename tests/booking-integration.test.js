import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingIntegrationService } from '../src/application/booking-integration-service.js';
import { CAPABILITY } from '../src/entitlements/capabilities.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
  RESERVATION_PHASE,
  classifyProviderError,
  normalizeAvailabilityResult,
} from '../src/integrations/calendar-contract.js';
import {
  BookingIntegrationDeniedError,
  BookingIntegrationError,
} from '../src/integrations/errors.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

function request(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'request-1',
    requesterUserId: USER_ID,
    roomId: 'room-1',
    status: 'Submitted',
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 4,
    externalParticipants: 1,
    statusChangedAt: '2026-08-24T09:00:00.000Z',
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles: ['conference_manager'],
    permissions: ['request:read', 'request:manage'],
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    request: request(),
    correlationId: CORRELATION_ID,
    phase: RESERVATION_PHASE.PROVISIONAL,
    ...overrides,
  };
}

function createRepository({ conflict = false, failFirstCreate = false } = {}) {
  let reference = null;
  let createAttempts = 0;
  return {
    async hasConflictingRequest() {
      return conflict;
    },
    async findProviderReferenceByRequest() {
      return reference;
    },
    async createProviderReference(values) {
      createAttempts += 1;
      if (failFirstCreate && createAttempts === 1) throw new Error('EXPECTED_LOCAL_PERSISTENCE_FAILURE');
      if (reference) return { reference, created: false };
      reference = {
        providerReference: values.providerReference,
        idempotencyKey: values.idempotencyKey,
        state: 'active',
      };
      return { reference, created: true };
    },
    async touchProviderReference() {
      if (!reference || reference.state !== 'active') throw new Error('REFERENCE_NOT_ACTIVE');
      return reference;
    },
    async cancelProviderReference() {
      if (!reference || reference.state !== 'active') throw new Error('REFERENCE_NOT_ACTIVE');
      reference = { ...reference, state: 'cancelled' };
      return reference;
    },
    get reference() {
      return reference;
    },
  };
}

function createAuditService() {
  const recorded = [];
  return {
    recorded,
    createEvent(values) {
      return Object.freeze({ ...values });
    },
    async record(values) {
      recorded.push(values);
      return values;
    },
  };
}

function createProvider(overrides = {}) {
  const externalByIdempotency = new Map();
  let actualCreates = 0;
  let createCalls = 0;
  let cancelCalls = 0;
  const provider = {
    integrationId: INTEGRATION_ID,
    async lookupAvailability() {
      return { available: true, conflictCount: 0 };
    },
    async validateReservation() {
      return { valid: true, reason: 'available' };
    },
    async createCalendarEvent(input) {
      createCalls += 1;
      if (externalByIdempotency.has(input.idempotencyKey)) {
        return {
          providerReference: externalByIdempotency.get(input.idempotencyKey),
          disposition: 'existing',
        };
      }
      actualCreates += 1;
      const providerReference = `provider-event-${actualCreates}`;
      externalByIdempotency.set(input.idempotencyKey, providerReference);
      return { providerReference, disposition: 'created' };
    },
    async updateCalendarEvent(input) {
      return { providerReference: input.providerReference, disposition: 'updated' };
    },
    async cancelCalendarEvent(input) {
      cancelCalls += 1;
      return { providerReference: input.providerReference, disposition: 'cancelled' };
    },
    ...overrides,
  };
  return {
    provider,
    get actualCreates() {
      return actualCreates;
    },
    get createCalls() {
      return createCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

function createService({ repository, provider, auditService, authorizeOperation } = {}) {
  return createBookingIntegrationService({
    repository: repository || createRepository(),
    provider: provider || createProvider().provider,
    entitlementService: { async requireAccess() { return true; } },
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    auditService: auditService || createAuditService(),
    authorizeOperation: authorizeOperation || (async () => true),
    clock: () => Date.parse('2026-08-24T10:00:00.000Z'),
  });
}

test('provider response and failure contracts are bounded and fail closed', () => {
  assert.deepEqual(normalizeAvailabilityResult({ available: true, conflictCount: 0 }), {
    available: true,
    conflictCount: 0,
  });
  assert.throws(
    () => normalizeAvailabilityResult({ available: true, conflictCount: 1 }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.MALFORMED_RESPONSE,
  );
  assert.equal(classifyProviderError(
    new CalendarProviderError(PROVIDER_ERROR_KIND.TIMEOUT, { operation: 'create' }),
    'create',
  ).retryable, true);
  assert.equal(classifyProviderError(new Error('raw provider detail'), 'create').retryable, false);
});

test('booking integration authorization is deny-by-default and tenant scope is fail-closed', async () => {
  const denied = createService({ authorizeOperation: async () => false });
  await assert.rejects(denied.lookupAvailability(context()), BookingIntegrationDeniedError);

  const allowed = createService();
  await assert.rejects(
    allowed.lookupAvailability(context({
      principal: principal({ tenantId: OTHER_TENANT_ID }),
    })),
    BookingIntegrationDeniedError,
  );
});

test('local room conflicts short-circuit provider availability and reservation validation', async () => {
  const repository = createRepository({ conflict: true });
  let providerCalls = 0;
  const provider = createProvider({
    async lookupAvailability() {
      providerCalls += 1;
      return { available: true, conflictCount: 0 };
    },
    async validateReservation() {
      providerCalls += 1;
      return { valid: true, reason: 'available' };
    },
  }).provider;
  const service = createService({ repository, provider });
  assert.deepEqual(await service.lookupAvailability(context()), { available: false, conflictCount: 1 });
  assert.deepEqual(await service.validateReservation(context()), { valid: false, reason: 'conflict' });
  assert.equal(providerCalls, 0);
});

test('provider availability and provisional/final validation stay provider-neutral', async () => {
  const phases = [];
  const provider = createProvider({
    async lookupAvailability(input) {
      phases.push(input.phase);
      assert.equal(input.roomId, 'room-1');
      assert.equal(Object.hasOwn(input, 'providerReference'), false);
      return { available: true, conflictCount: 0 };
    },
    async validateReservation(input) {
      phases.push(input.phase);
      return { valid: true, reason: 'available' };
    },
  }).provider;
  const service = createService({ provider });
  assert.equal((await service.lookupAvailability(context())).available, true);
  assert.equal((await service.validateReservation(context({ phase: RESERVATION_PHASE.FINAL }))).valid, true);
  assert.deepEqual(phases, [RESERVATION_PHASE.PROVISIONAL, RESERVATION_PHASE.FINAL]);
});

test('create is idempotent across normal repeats and recovery after local persistence failure', async () => {
  const providerState = createProvider();
  const repository = createRepository();
  const service = createService({ repository, provider: providerState.provider });
  assert.deepEqual(await service.createCalendarEvent(context()), { disposition: 'created', state: 'active' });
  assert.deepEqual(await service.createCalendarEvent(context()), { disposition: 'existing', state: 'active' });
  assert.equal(providerState.createCalls, 1);
  assert.equal(providerState.actualCreates, 1);

  const recoveryProvider = createProvider();
  const recoveryRepository = createRepository({ failFirstCreate: true });
  const recoveryService = createService({
    repository: recoveryRepository,
    provider: recoveryProvider.provider,
  });
  await assert.rejects(
    recoveryService.createCalendarEvent(context()),
    /EXPECTED_LOCAL_PERSISTENCE_FAILURE/,
  );
  assert.deepEqual(
    await recoveryService.createCalendarEvent(context()),
    { disposition: 'existing', state: 'active' },
  );
  assert.equal(recoveryProvider.createCalls, 2);
  assert.equal(recoveryProvider.actualCreates, 1);
});

test('provider timeouts and malformed responses expose stable retry semantics without raw details', async () => {
  const auditService = createAuditService();
  const timeoutProvider = createProvider({
    async createCalendarEvent() {
      throw new CalendarProviderError(PROVIDER_ERROR_KIND.TIMEOUT, {
        operation: 'create',
        retryAfterMs: 1_000,
      });
    },
  }).provider;
  const timeoutService = createService({ provider: timeoutProvider, auditService });
  await assert.rejects(
    timeoutService.createCalendarEvent(context()),
    (error) => error instanceof BookingIntegrationError
      && error.code === 'CALENDAR_PROVIDER_TIMEOUT'
      && error.retryable === true
      && error.retryAfterMs === 1_000,
  );
  assert.equal(auditService.recorded[0].metadata.retryable, true);

  const malformedProvider = createProvider({
    async lookupAvailability() {
      return { available: 'yes', conflictCount: 0 };
    },
  }).provider;
  const malformedService = createService({ provider: malformedProvider, auditService: createAuditService() });
  await assert.rejects(
    malformedService.lookupAvailability(context()),
    (error) => error instanceof BookingIntegrationError
      && error.code === 'CALENDAR_PROVIDER_RESPONSE_INVALID'
      && error.retryable === false,
  );
});

test('update and cancel use the persisted opaque reference and repeated cancel is a no-op', async () => {
  const repository = createRepository();
  let updatedReference = null;
  const providerState = createProvider({
    async updateCalendarEvent(input) {
      updatedReference = input.providerReference;
      return { providerReference: input.providerReference, disposition: 'unchanged' };
    },
  });
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());
  assert.deepEqual(await service.updateCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'unchanged',
    state: 'active',
  });
  assert.equal(updatedReference, repository.reference.providerReference);
  assert.deepEqual(await service.cancelCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'cancelled',
    state: 'cancelled',
  });
  assert.deepEqual(await service.cancelCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'already_cancelled',
    state: 'cancelled',
  });
  assert.equal(providerState.cancelCalls, 1);
});

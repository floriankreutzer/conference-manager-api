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
const PROVIDER_RESOURCE_REFERENCE = 'room-1@example.invalid';
const PROVIDER_CONNECTION_REFERENCE = 'provider-tenant-a';

function request(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'request-1',
    requesterUserId: USER_ID,
    requesterAttribution: { displayName: 'Persisted requester' },
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

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return Object.freeze({ promise, resolve });
}

function createRepository({
  conflict = false,
  failFirstCreate = false,
  authorityLostOnFirstCreate = false,
  compensationOwnerCurrent = () => true,
} = {}) {
  let reference = null;
  let createAttempts = 0;
  const compensationBegins = [];
  return {
    async hasConflictingRequest() {
      return conflict;
    },
    async findProviderReferenceByRequest() {
      return reference;
    },
    async reserveProviderResourceBinding(values) {
      if (reference) {
        if (reference.state === 'cancelled' || reference.idempotencyKey !== values.idempotencyKey) {
          throw new Error('REFERENCE_CREATE_CONFLICT');
        }
        return { reference, created: false };
      }
      reference = {
        integrationId: INTEGRATION_ID,
        providerReference: null,
        providerConnectionReference: values.providerConnectionReference,
        providerResourceReference: values.providerResourceReference,
        idempotencyKey: values.idempotencyKey,
        attemptNumber: 1,
        state: 'pending',
      };
      return { reference, created: true };
    },
    async retryProviderResourceBinding(values) {
      if (!reference || reference.state !== 'compensated') {
        throw new Error('REFERENCE_RETRY_CONFLICT');
      }
      reference = {
        ...reference,
        providerReference: null,
        providerConnectionReference: values.providerConnectionReference,
        providerResourceReference: values.providerResourceReference,
        idempotencyKey: values.idempotencyKey,
        attemptNumber: values.nextAttemptNumber,
        state: 'pending',
      };
      return { reference, created: true };
    },
    async createProviderReference(values) {
      createAttempts += 1;
      if (failFirstCreate && createAttempts === 1) throw new Error('EXPECTED_LOCAL_PERSISTENCE_FAILURE');
      if (authorityLostOnFirstCreate && createAttempts === 1 && reference?.state === 'pending') {
        reference = {
          ...reference,
          providerReference: values.providerReference,
          state: 'compensating',
        };
        return { reference, created: true, authorityLost: true };
      }
      if (['pending', 'compensating', 'compensated'].includes(reference?.state)) {
        reference = {
          ...reference,
          providerReference: values.providerReference,
          providerConnectionReference: values.providerConnectionReference,
          providerResourceReference: values.providerResourceReference,
          state: 'active',
        };
        return { reference, created: true };
      }
      if (reference?.state === 'active') {
        if (
          reference.idempotencyKey !== values.idempotencyKey
          || reference.providerConnectionReference !== values.providerConnectionReference
          || reference.providerResourceReference !== values.providerResourceReference
        ) {
          throw new Error('REFERENCE_CREATE_CONFLICT');
        }
        if (reference.providerReference === values.providerReference) {
          return { reference, created: false };
        }
        throw new Error('REFERENCE_CREATE_CONFLICT');
      }
      throw new Error('REFERENCE_CREATE_CONFLICT');
    },
    async touchProviderReference() {
      if (!reference || reference.state !== 'active') throw new Error('REFERENCE_NOT_ACTIVE');
      return reference;
    },
    async cancelProviderReference() {
      if (reference?.state === 'cancelled') return reference;
      if (!reference || !['active', 'compensating', 'compensated'].includes(reference.state)) {
        throw new Error('REFERENCE_NOT_ACTIVE');
      }
      reference = { ...reference, state: 'cancelled' };
      return reference;
    },
    async beginCompensatingProviderReference(values) {
      if (!reference || !['active', 'compensating'].includes(reference.state)) {
        throw new Error('REFERENCE_NOT_ACTIVE');
      }
      compensationBegins.push(values);
      if (reference.state === 'active' && !await compensationOwnerCurrent(values)) return null;
      reference = { ...reference, state: 'compensating' };
      return reference;
    },
    async completeCompensatingProviderReference() {
      if (!reference || !['compensating', 'compensated'].includes(reference.state)) {
        throw new Error('REFERENCE_NOT_COMPENSATING');
      }
      reference = { ...reference, state: 'compensated' };
      return reference;
    },
    get reference() {
      return reference;
    },
    get compensationBegins() {
      return compensationBegins;
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
    providerConnectionReference: PROVIDER_CONNECTION_REFERENCE,
    providerResourceReference: PROVIDER_RESOURCE_REFERENCE,
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
          providerResourceReference: input.providerResourceReference,
          disposition: 'existing',
        };
      }
      actualCreates += 1;
      const providerReference = `provider-event-${actualCreates}`;
      externalByIdempotency.set(input.idempotencyKey, providerReference);
      return {
        providerReference,
        providerResourceReference: input.providerResourceReference,
        disposition: 'created',
      };
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

function createService({ repository, provider, auditService, authorizeOperation, entitlementService } = {}) {
  return createBookingIntegrationService({
    repository: repository || createRepository(),
    provider: provider || createProvider().provider,
    entitlementService: entitlementService || { async requireAccess() { return true; } },
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

test('pending create on an obsolete resource is reconciled before a new resource attempt', async () => {
  const originalResource = 'room-original@example.invalid';
  const remappedResource = 'room-remapped@example.invalid';
  const repository = createRepository({ failFirstCreate: true });
  const externalEvents = new Map();
  const createResources = [];
  const cancelResources = [];
  let actualCreates = 0;
  function boundProvider(providerResourceReference) {
    return createProvider({
      providerResourceReference,
      async createCalendarEvent(input) {
        createResources.push(input.providerResourceReference);
        const scope = `${input.providerResourceReference}:${input.idempotencyKey}`;
        const existing = externalEvents.has(scope);
        if (!existing) {
          actualCreates += 1;
          externalEvents.set(scope, `provider-event-${actualCreates}`);
        }
        return {
          providerReference: externalEvents.get(scope),
          providerResourceReference: input.providerResourceReference,
          disposition: existing ? 'existing' : 'created',
        };
      },
      async cancelCalendarEvent(input) {
        cancelResources.push(input.providerResourceReference);
        return { providerReference: input.providerReference, disposition: 'cancelled' };
      },
    }).provider;
  }

  const firstService = createService({
    repository,
    provider: boundProvider(originalResource),
  });
  await assert.rejects(
    firstService.createCalendarEvent(context()),
    /EXPECTED_LOCAL_PERSISTENCE_FAILURE/,
  );
  assert.equal(repository.reference.state, 'pending');
  assert.equal(repository.reference.providerReference, null);
  assert.equal(repository.reference.providerResourceReference, originalResource);

  const retryService = createService({
    repository,
    provider: boundProvider(remappedResource),
  });
  assert.deepEqual(await retryService.createCalendarEvent(context()), {
    disposition: 'created',
    state: 'active',
  });
  assert.equal(actualCreates, 2);
  assert.deepEqual(createResources, [originalResource, originalResource, remappedResource]);
  assert.deepEqual(cancelResources, [originalResource]);
  assert.equal(repository.reference.providerResourceReference, remappedResource);
  assert.equal(repository.reference.attemptNumber, 2);
});

test('active create on an obsolete resource is compensated before current-resource creation', async () => {
  const originalResource = 'room-original@example.invalid';
  const remappedResource = 'room-remapped@example.invalid';
  const repository = createRepository();
  const createResources = [];
  const cancelResources = [];
  let eventNumber = 0;
  function boundProvider(providerResourceReference) {
    return createProvider({
      providerResourceReference,
      async createCalendarEvent(input) {
        createResources.push(input.providerResourceReference);
        eventNumber += 1;
        return {
          providerReference: `provider-event-${eventNumber}`,
          providerResourceReference: input.providerResourceReference,
          disposition: 'created',
        };
      },
      async cancelCalendarEvent(input) {
        cancelResources.push(input.providerResourceReference);
        return { providerReference: input.providerReference, disposition: 'cancelled' };
      },
    }).provider;
  }

  const original = createService({ repository, provider: boundProvider(originalResource) });
  assert.equal((await original.createCalendarEvent(context())).state, 'active');
  const remapped = createService({ repository, provider: boundProvider(remappedResource) });
  assert.deepEqual(await remapped.createCalendarEvent(context()), {
    disposition: 'created',
    state: 'active',
  });
  assert.deepEqual(createResources, [originalResource, remappedResource]);
  assert.deepEqual(cancelResources, [originalResource]);
  assert.equal(repository.reference.providerResourceReference, remappedResource);
  assert.equal(repository.reference.attemptNumber, 2);
});

test('cancellation reconciles an unknown pending create outcome before deleting the event', async () => {
  const repository = createRepository();
  let createCalls = 0;
  let cancelCalls = 0;
  let eventPresent = false;
  const provider = createProvider({
    async createCalendarEvent(input) {
      createCalls += 1;
      if (createCalls === 1) {
        eventPresent = true;
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.TIMEOUT, { operation: 'create' });
      }
      return {
        providerReference: 'provider-event-reconciled',
        providerResourceReference: input.providerResourceReference,
        disposition: eventPresent ? 'existing' : 'created',
      };
    },
    async cancelCalendarEvent(input) {
      cancelCalls += 1;
      assert.equal(input.providerReference, 'provider-event-reconciled');
      eventPresent = false;
      return { providerReference: input.providerReference, disposition: 'cancelled' };
    },
  }).provider;
  const service = createService({ repository, provider });

  await assert.rejects(
    service.createCalendarEvent(context()),
    (error) => error instanceof BookingIntegrationError
      && error.code === 'CALENDAR_PROVIDER_TIMEOUT',
  );
  assert.equal(repository.reference.state, 'pending');
  assert.equal(repository.reference.providerReference, null);
  assert.equal(eventPresent, true);

  assert.deepEqual(await service.cancelCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'cancelled',
    state: 'cancelled',
  });
  assert.equal(createCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(eventPresent, false);
  assert.equal(repository.reference.state, 'cancelled');
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
  let updatedResourceReference = null;
  let cancelledResourceReference = null;
  const providerState = createProvider({
    async updateCalendarEvent(input) {
      updatedReference = input.providerReference;
      updatedResourceReference = input.providerResourceReference;
      return { providerReference: input.providerReference, disposition: 'unchanged' };
    },
    async cancelCalendarEvent(input) {
      cancelledResourceReference = input.providerResourceReference;
      return { providerReference: input.providerReference, disposition: 'cancelled' };
    },
  });
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());
  assert.deepEqual(await service.updateCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'unchanged',
    state: 'active',
  });
  assert.equal(updatedReference, repository.reference.providerReference);
  assert.equal(updatedResourceReference, PROVIDER_RESOURCE_REFERENCE);
  assert.deepEqual(await service.cancelCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'cancelled',
    state: 'cancelled',
  });
  assert.deepEqual(await service.cancelCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'already_cancelled',
    state: 'cancelled',
  });
  assert.equal(cancelledResourceReference, PROVIDER_RESOURCE_REFERENCE);
  assert.equal(repository.compensationBegins.length, 0);
});

test('cleanup of an existing reference remains authorized after calendar-write entitlement is disabled', async () => {
  const repository = createRepository();
  const providerState = createProvider();
  let enabled = true;
  const service = createService({
    repository,
    provider: providerState.provider,
    entitlementService: {
      async requireAccess() {
        if (!enabled) throw new Error('CALENDAR_WRITE_DISABLED');
        return true;
      },
    },
  });

  await service.createCalendarEvent(context());
  enabled = false;
  assert.deepEqual(await service.cancelCalendarEvent(context({ phase: RESERVATION_PHASE.FINAL })), {
    disposition: 'cancelled',
    state: 'cancelled',
  });
  assert.equal(providerState.cancelCalls, 1);
});

test('pre-confirm cleanup retains an active event when its held Request owner becomes stale', async () => {
  const ownerCheckStarted = deferred();
  const releaseOwnerCheck = deferred();
  let ownerCurrent = true;
  const repository = createRepository({
    async compensationOwnerCurrent() {
      ownerCheckStarted.resolve();
      await releaseOwnerCheck.promise;
      return ownerCurrent;
    },
  });
  const providerState = createProvider();
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());

  const cleanup = service.cancelCalendarEventBeforeConfirmation(
    context({ phase: RESERVATION_PHASE.FINAL }),
  );
  await ownerCheckStarted.promise;
  ownerCurrent = false;
  releaseOwnerCheck.resolve();

  await assert.rejects(
    cleanup,
    (error) => error instanceof BookingIntegrationError
      && error.code === 'BOOKING_REFERENCE_RECONCILIATION_REQUIRED',
  );
  assert.equal(repository.reference.state, 'active');
  assert.equal(providerState.cancelCalls, 0);
  assert.deepEqual(repository.compensationBegins.map((entry) => entry.expectedRequestVersion), [1]);
});

test('pre-confirm cleanup durably owns the reference before external delete', async () => {
  const deleteStarted = deferred();
  const releaseDelete = deferred();
  let deletes = 0;
  const repository = createRepository();
  const providerState = createProvider({
    async cancelCalendarEvent(input) {
      deletes += 1;
      deleteStarted.resolve();
      await releaseDelete.promise;
      return { providerReference: input.providerReference, disposition: 'cancelled' };
    },
  });
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());

  const cleanup = service.cancelCalendarEventBeforeConfirmation(
    context({ phase: RESERVATION_PHASE.FINAL }),
  );
  await deleteStarted.promise;
  assert.equal(repository.reference.state, 'compensating');
  releaseDelete.resolve();

  const cleaned = await cleanup;
  assert.equal(cleaned.state, 'compensated');
  assert.deepEqual(cleaned.reference, {
    integrationId: INTEGRATION_ID,
    providerReference: repository.reference.providerReference,
    providerConnectionReference: PROVIDER_CONNECTION_REFERENCE,
    providerResourceReference: PROVIDER_RESOURCE_REFERENCE,
  });
  assert.equal(repository.reference.state, 'compensated');
  assert.equal(deletes, 1);
});

test('pre-confirm cleanup reconciles pending create and resumes unknown delete outcomes', async () => {
  const repository = createRepository();
  let creates = 0;
  let deletes = 0;
  const providerState = createProvider({
    async createCalendarEvent(input) {
      creates += 1;
      if (creates === 1) {
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.TIMEOUT, { operation: 'create' });
      }
      return {
        providerReference: 'provider-event-reconciled',
        providerResourceReference: input.providerResourceReference,
        disposition: 'existing',
      };
    },
    async cancelCalendarEvent(input) {
      deletes += 1;
      if (deletes === 1) {
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.TIMEOUT, { operation: 'cancel' });
      }
      return { providerReference: input.providerReference, disposition: 'already_cancelled' };
    },
  });
  const service = createService({ repository, provider: providerState.provider });
  await assert.rejects(
    service.createCalendarEvent(context()),
    (error) => error instanceof BookingIntegrationError
      && error.code === 'CALENDAR_PROVIDER_TIMEOUT',
  );
  assert.equal(repository.reference.state, 'pending');

  await assert.rejects(
    service.cancelCalendarEventBeforeConfirmation(context({ phase: RESERVATION_PHASE.FINAL })),
    (error) => error instanceof BookingIntegrationError
      && error.code === 'CALENDAR_PROVIDER_TIMEOUT',
  );
  assert.equal(repository.reference.state, 'compensating');
  assert.equal(creates, 2);
  assert.equal(deletes, 1);

  const cleaned = await service.cancelCalendarEventBeforeConfirmation(
    context({ phase: RESERVATION_PHASE.FINAL }),
  );
  assert.equal(cleaned.state, 'compensated');
  assert.equal(cleaned.disposition, 'already_cancelled');
  assert.equal(repository.reference.state, 'compensated');
  assert.equal(deletes, 2);

  const repeated = await service.cancelCalendarEventBeforeConfirmation(
    context({ phase: RESERVATION_PHASE.FINAL }),
  );
  assert.equal(repeated.state, 'compensated');
  assert.equal(repeated.disposition, 'already_cancelled');
  assert.equal(deletes, 2);
});

test('pre-confirm cleanup converges an unknown local completion without another provider delete', async () => {
  const repository = createRepository();
  const originalComplete = repository.completeCompensatingProviderReference;
  let loseResponse = true;
  repository.completeCompensatingProviderReference = async (...args) => {
    const result = await originalComplete(...args);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('PRE_CONFIRM_CLEANUP_FINALIZE_RESPONSE_LOST');
    }
    return result;
  };
  const providerState = createProvider();
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());

  await assert.rejects(
    service.cancelCalendarEventBeforeConfirmation(context({ phase: RESERVATION_PHASE.FINAL })),
    /PRE_CONFIRM_CLEANUP_FINALIZE_RESPONSE_LOST/,
  );
  assert.equal(repository.reference.state, 'compensated');
  assert.equal(providerState.cancelCalls, 1);
  const repeated = await service.cancelCalendarEventBeforeConfirmation(
    context({ phase: RESERVATION_PHASE.FINAL }),
  );
  assert.equal(repeated.state, 'compensated');
  assert.equal(repeated.disposition, 'already_cancelled');
  assert.equal(providerState.cancelCalls, 1);
});

test('pre-confirm cleanup treats absent and terminal-cancelled references as local no-ops', async () => {
  const repository = createRepository();
  const providerState = createProvider();
  const service = createService({ repository, provider: providerState.provider });
  assert.deepEqual(await service.cancelCalendarEventBeforeConfirmation(context()), {
    disposition: 'not_present',
    state: 'cancelled',
    reference: null,
  });

  await service.createCalendarEvent(context());
  await service.cancelCalendarEvent(context());
  assert.deepEqual(await service.cancelCalendarEventBeforeConfirmation(context()), {
    disposition: 'already_cancelled',
    state: 'cancelled',
    reference: null,
  });
  assert.equal(providerState.cancelCalls, 1);
  assert.equal(repository.compensationBegins.length, 0);
});

test('unknown local cancellation finalize is idempotent after a repeated provider delete', async () => {
  const repository = createRepository();
  const originalCancel = repository.cancelProviderReference;
  let loseResponse = true;
  repository.cancelProviderReference = async (...args) => {
    const result = await originalCancel(...args);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('CANCEL_FINALIZE_RESPONSE_LOST');
    }
    return result;
  };
  const providerState = createProvider({
    async cancelCalendarEvent(input) {
      return {
        providerReference: input.providerReference,
        disposition: loseResponse ? 'cancelled' : 'already_cancelled',
      };
    },
  });
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());
  await assert.rejects(service.cancelCalendarEvent(context()), /CANCEL_FINALIZE_RESPONSE_LOST/);
  assert.equal(repository.reference.state, 'cancelled');
  assert.deepEqual(await service.cancelCalendarEvent(context()), {
    disposition: 'already_cancelled',
    state: 'cancelled',
  });
});

test('unknown compensation-finalize response converges without another external delete', async () => {
  const repository = createRepository();
  const originalComplete = repository.completeCompensatingProviderReference;
  let loseResponse = true;
  repository.completeCompensatingProviderReference = async (...args) => {
    const result = await originalComplete(...args);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('COMPENSATION_FINALIZE_RESPONSE_LOST');
    }
    return result;
  };
  const providerState = createProvider();
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());
  await assert.rejects(
    service.compensateCalendarEvent(context()),
    /COMPENSATION_FINALIZE_RESPONSE_LOST/,
  );
  assert.equal(repository.reference.state, 'compensated');
  assert.deepEqual(await service.compensateCalendarEvent(context()), {
    disposition: 'already_cancelled',
    state: 'compensated',
  });
  assert.equal(providerState.cancelCalls, 1);
});

test('compensation is an idempotent no-op when a concurrent abandonment already cancelled the reference', async () => {
  const repository = createRepository();
  const providerState = createProvider();
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());
  await service.cancelCalendarEvent(context());
  assert.deepEqual(await service.compensateCalendarEvent(context()), {
    disposition: 'already_cancelled',
    state: 'cancelled',
  });
  assert.equal(providerState.cancelCalls, 1);
});

test('compensation retains the active event after the expected Request version loses ownership', async () => {
  const observedVersions = [];
  const repository = createRepository({
    compensationOwnerCurrent(values) {
      observedVersions.push(values.expectedRequestVersion);
      return false;
    },
  });
  const providerState = createProvider();
  const service = createService({ repository, provider: providerState.provider });
  await service.createCalendarEvent(context());

  assert.deepEqual(await service.compensateCalendarEvent(context()), {
    disposition: 'retained',
    state: 'active',
  });
  assert.deepEqual(observedVersions, [1]);
  assert.equal(repository.reference.state, 'active');
  assert.equal(providerState.cancelCalls, 0);
});

test('compensated retry rebinds the current resource with a monotone attempt and new idempotency key', async () => {
  const repository = createRepository();
  let createAttempt = 0;
  const idempotencyKeys = [];
  const providerState = createProvider({
    async createCalendarEvent(input) {
      createAttempt += 1;
      idempotencyKeys.push(input.idempotencyKey);
      return {
        providerReference: `provider-event-${createAttempt}`,
        providerResourceReference: input.providerResourceReference,
        disposition: 'created',
      };
    },
  });
  const service = createService({ repository, provider: providerState.provider });

  assert.equal((await service.createCalendarEvent(context())).state, 'active');
  assert.deepEqual(await service.compensateCalendarEvent(context()), {
    disposition: 'cancelled',
    state: 'compensated',
  });
  assert.equal(repository.reference.state, 'compensated');

  const restoredResource = 'room-restored@example.invalid';
  const restoredService = createService({
    repository,
    provider: {
      ...providerState.provider,
      providerResourceReference: restoredResource,
    },
  });
  assert.deepEqual(await restoredService.createCalendarEvent(context()), {
    disposition: 'created',
    state: 'active',
  });
  assert.equal(repository.reference.providerReference, 'provider-event-2');
  assert.equal(repository.reference.providerResourceReference, restoredResource);
  assert.equal(repository.reference.attemptNumber, 2);
  assert.equal(idempotencyKeys.length, 2);
  assert.notEqual(idempotencyKeys[0], idempotencyKeys[1]);
  assert.equal(repository.reference.state, 'active');
});

test('authority loss after provider create compensates before a fresh-attempt retry', async () => {
  const repository = createRepository({ authorityLostOnFirstCreate: true });
  const keys = [];
  let eventNumber = 0;
  const providerState = createProvider({
    async createCalendarEvent(input) {
      keys.push(input.idempotencyKey);
      eventNumber += 1;
      return {
        providerReference: `authority-event-${eventNumber}`,
        providerResourceReference: input.providerResourceReference,
        disposition: 'created',
      };
    },
  });
  const service = createService({ repository, provider: providerState.provider });
  await assert.rejects(
    service.createCalendarEvent(context()),
    (error) => error instanceof BookingIntegrationError
      && error.code === 'BOOKING_CREATE_AUTHORITY_LOST',
  );
  assert.equal(providerState.cancelCalls, 1);
  assert.equal(repository.reference.state, 'compensated');

  const restored = createService({
    repository,
    provider: {
      ...providerState.provider,
    },
  });
  assert.deepEqual(await restored.createCalendarEvent(context()), {
    disposition: 'created',
    state: 'active',
  });
  assert.equal(repository.reference.attemptNumber, 2);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('a create retry converges an incomplete compensation before using a fresh attempt', async () => {
  const repository = createRepository();
  const originalCompensate = repository.completeCompensatingProviderReference;
  let rejectCompensationPersistence = true;
  repository.completeCompensatingProviderReference = async (...args) => {
    if (rejectCompensationPersistence) {
      rejectCompensationPersistence = false;
      throw new Error('EXPECTED_COMPENSATION_PERSISTENCE_FAILURE');
    }
    return originalCompensate(...args);
  };
  let eventPresent = false;
  let eventNumber = 0;
  const provider = createProvider({
    async createCalendarEvent(input) {
      const created = !eventPresent;
      if (created) {
        eventNumber += 1;
        eventPresent = true;
      }
      return {
        providerReference: `provider-event-${eventNumber}`,
        providerResourceReference: input.providerResourceReference ?? PROVIDER_RESOURCE_REFERENCE,
        disposition: created ? 'created' : 'existing',
      };
    },
    async cancelCalendarEvent(input) {
      eventPresent = false;
      return { providerReference: input.providerReference, disposition: 'cancelled' };
    },
  }).provider;
  const service = createService({ repository, provider });

  await service.createCalendarEvent(context());
  await assert.rejects(
    service.compensateCalendarEvent(context()),
    /EXPECTED_COMPENSATION_PERSISTENCE_FAILURE/,
  );
  assert.equal(repository.reference.state, 'compensating');
  assert.equal(eventPresent, false);

  assert.deepEqual(await service.createCalendarEvent(context()), {
    disposition: 'created',
    state: 'active',
  });
  assert.equal(eventPresent, true);
  assert.equal(repository.reference.providerReference, 'provider-event-2');
  assert.equal(repository.reference.providerResourceReference, PROVIDER_RESOURCE_REFERENCE);
  assert.equal(repository.reference.attemptNumber, 2);
});

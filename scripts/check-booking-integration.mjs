import { readFile } from 'node:fs/promises';

const contract = await readFile('src/integrations/calendar-contract.js', 'utf8');
const service = await readFile('src/application/booking-integration-service.js', 'utf8');
const finalConfirmationService = await readFile(
  'src/application/final-room-confirmation-service.js',
  'utf8',
);
const repository = await readFile('src/persistence/postgres/booking-reference-repository.js', 'utf8');
const requestRepository = await readFile('src/persistence/postgres/request-repository.js', 'utf8');
const bookingChangeRepository = await readFile(
  'src/persistence/postgres/booking-change-repository.js',
  'utf8',
);
const calendarAuthorityGuard = await readFile(
  'src/persistence/postgres/calendar-authority-guard.js',
  'utf8',
);
const migration = await readFile('migrations/006_booking_provider_references.up.sql', 'utf8');
const bookingContract = await readFile('docs/BOOKING-INTEGRATION.md', 'utf8');
const microsoftWriteContract = await readFile('docs/MICROSOFT365-CALENDAR-WRITE.md', 'utf8');

for (const required of [
  'lookupAvailability',
  'validateReservation',
  'createCalendarEvent',
  'updateCalendarEvent',
  'cancelCalendarEvent',
  'MALFORMED_RESPONSE',
  'retryable',
]) {
  if (!contract.includes(required)) throw new Error(`Calendar provider contract is missing ${required}.`);
}

for (const [document, label] of [
  [bookingContract, 'Booking integration contract'],
  [microsoftWriteContract, 'Microsoft calendar-write contract'],
]) {
  for (const required of [
    '`pending`',
    '`compensating`',
    'persisted create-time resource',
    '`compensated`',
    'repeats create idempotently',
  ]) {
    if (!document.includes(required)) throw new Error(`${label} is missing ${required}.`);
  }
}

if (/microsoft|graph\.microsoft|https?:\/\//i.test(contract)) {
  throw new Error('Provider-neutral calendar contract must not contain Microsoft-specific or outbound URL details.');
}
if (/microsoft|graph\.microsoft|https?:\/\//i.test(service)) {
  throw new Error('Booking application service must remain provider-neutral and URL-free.');
}
for (const required of [
  'authorizeOperation = async () => false',
  'entitlementService.requireAccess',
  "createHash('sha256')",
  'hasConflictingRequest',
  'reserveProviderResourceBinding',
  'providerResourceReference: reference.providerResourceReference',
  'providerConnectionReference: calendarProvider.providerConnectionReference',
  'expectedRequestVersion: request.version',
  'cancelCalendarEventBeforeConfirmation',
  "operation === BOOKING_PROVIDER_OPERATION.CANCEL",
  'normalizeCreateResult',
  'classifyProviderError',
  'AUDIT_ACTION.CALENDAR_OPERATION',
]) {
  if (!service.includes(required)) throw new Error(`Booking service is missing boundary invariant ${required}.`);
}
for (const required of [
  'cancelCalendarEventBeforeConfirmation',
  'calendarCleanupAuditEvent',
  'calendarCleanup:',
]) {
  if (!finalConfirmationService.includes(required)) {
    throw new Error(`Final confirmation cleanup is missing ${required}.`);
  }
}

for (const required of [
  'WHERE tenant_id = $1',
  'booking_provider_references',
  'pg_advisory_xact_lock',
  "'pending'",
  "state <> 'cancelled'",
  'booking-lock-current-create-authority',
  'booking-lock-current-cleanup-authority',
  'booking-resource-binding-lock-eligible-request',
  'booking-resource-binding-retry',
  'booking-reference-lock-compensatable-request',
  'request_version = $3',
  'attempt_number',
  "status IN ('Submitted', 'In Review')",
  'beginCompensatingProviderReference',
  'completeCompensatingProviderReference',
  'appendWithClient(client, auditEvent)',
  "status NOT IN ('Rejected', 'Cancelled')",
]) {
  if (!repository.includes(required)) throw new Error(`Booking persistence is missing ${required}.`);
}
for (const required of [
  'calendar-authority-lock-active-booking-reference',
  'calendar-authority-lock-write-disabled-booking-references',
  'calendar-authority-complete-pre-confirmation-cleanup',
  "state = 'active'",
  "state = 'compensated'",
  "state <> 'cancelled'",
  'FOR UPDATE',
  'FOR SHARE',
]) {
  if (!calendarAuthorityGuard.includes(required)) {
    throw new Error(`Calendar confirmation authority is missing ${required}.`);
  }
}
for (const required of [
  'completePreConfirmationCleanup',
  'calendarCleanup.auditEvent',
  'CALENDAR_CLEANUP_FINALIZE_FAILED',
]) {
  if (!requestRepository.includes(required)) {
    throw new Error(`Final confirmation persistence is missing ${required}.`);
  }
}

function repositoryMethod(source, methodName) {
  const marker = `    async ${methodName}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Request mutation inventory is missing ${methodName}.`);
  const nextMethod = source.indexOf('\n    async ', start + marker.length);
  return source.slice(start, nextMethod < 0 ? source.length : nextMethod);
}

function requireOrderedSteps(source, label, requiredSteps) {
  let previousStep = -1;
  for (const required of requiredSteps) {
    const index = source.indexOf(required, previousStep + 1);
    if (index < 0) throw new Error(`${label} is missing ordered step ${required}.`);
    previousStep = index;
  }
}

function requireRevisionBeforeAudits(source, repositoryLabel, methodName) {
  const method = repositoryMethod(source, methodName);
  const revision = method.indexOf('appendRequestRevisionWithClient(');
  if (revision < 0) {
    throw new Error(`${repositoryLabel}.${methodName} is missing its Request revision.`);
  }
  for (const audit of method.matchAll(/appendAudit\(/g)) {
    if (audit.index < revision) {
      throw new Error(`${repositoryLabel}.${methodName} acquires an audit lock before its Request revision lock.`);
    }
  }
  return method;
}

for (const methodName of [
  'createVersionedForTenant',
  'resubmitVersionedForTenant',
  'transitionByTenantIdAndId',
  'confirmIfRoomAvailable',
]) {
  requireRevisionBeforeAudits(requestRepository, 'requestRepository', methodName);
}
for (const methodName of ['propose', 'finishApproval']) {
  requireRevisionBeforeAudits(bookingChangeRepository, 'bookingChangeRepository', methodName);
}

const transitionPersistence = repositoryMethod(requestRepository, 'transitionByTenantIdAndId');
requireOrderedSteps(transitionPersistence, 'Request transition lock order', [
  "appendRequestRevisionWithClient(client, request, 'transitioned'",
  'appendAudit(client, auditRepository, bookingChangeAuditEvent)',
  'appendAudit(client, auditRepository, auditEvent)',
]);

const finalConfirmationPersistence = repositoryMethod(requestRepository, 'confirmIfRoomAvailable');
requireOrderedSteps(finalConfirmationPersistence, 'Final confirmation lock order', [
  'completePreConfirmationCleanup(client',
  "appendRequestRevisionWithClient(client, confirmed, 'transitioned'",
  'appendAudit(client, auditRepository, calendarCleanup.auditEvent)',
  'appendAudit(client, auditRepository, auditEvent)',
]);
if (/SELECT[^;]+FROM requests[^;]+WHERE id = \$1/is.test(repository)) {
  throw new Error('Booking persistence must not perform unscoped Request lookups.');
}

for (const required of [
  'PRIMARY KEY (tenant_id, request_id, integration_id)',
  'UNIQUE (tenant_id, integration_id, provider_reference)',
  'UNIQUE (tenant_id, integration_id, idempotency_key)',
  'REFERENCES requests(tenant_id, id)',
  'REFERENCES integrations(tenant_id, id)',
  "state IN ('active', 'cancelled')",
]) {
  if (!migration.includes(required)) throw new Error(`Booking migration is missing ${required}.`);
}

console.log('Booking integration boundary check passed.');

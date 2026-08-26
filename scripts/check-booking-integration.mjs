import { readFile } from 'node:fs/promises';

const contract = await readFile('src/integrations/calendar-contract.js', 'utf8');
const service = await readFile('src/application/booking-integration-service.js', 'utf8');
const repository = await readFile('src/persistence/postgres/booking-reference-repository.js', 'utf8');
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
  "operation === BOOKING_PROVIDER_OPERATION.CANCEL",
  'normalizeCreateResult',
  'classifyProviderError',
  'AUDIT_ACTION.CALENDAR_OPERATION',
]) {
  if (!service.includes(required)) throw new Error(`Booking service is missing boundary invariant ${required}.`);
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
  'attempt_number',
  "status IN ('Submitted', 'In Review')",
  'beginCompensatingProviderReference',
  'completeCompensatingProviderReference',
  'appendWithClient(client, auditEvent)',
  "status NOT IN ('Rejected', 'Cancelled')",
]) {
  if (!repository.includes(required)) throw new Error(`Booking persistence is missing ${required}.`);
}
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

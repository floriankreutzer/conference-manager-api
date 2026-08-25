import { readFile } from 'node:fs/promises';

async function text(path) {
  return readFile(path, 'utf8');
}

function requireContains(content, values, label) {
  for (const value of values) {
    if (!content.includes(value)) {
      throw new Error(`${label} is missing required Microsoft 365 lifecycle marker: ${value}`);
    }
  }
}

const migrationUp = await text('migrations/011_microsoft365_connection_lifecycle.up.sql');
const migrationDown = await text('migrations/011_microsoft365_connection_lifecycle.down.sql');
const service = await text('src/application/microsoft365-connection-service.js');
const providerClient = await text('src/integrations/microsoft365-client.js');
const providerClientTests = await text('tests/microsoft365-client.test.js');
const routes = await text('src/http/microsoft365-routes.js');
const repository = await text('src/persistence/postgres/microsoft365-connection-repository.js');
const contract = await text('docs/MICROSOFT365-CONNECTION.md');
const apiContract = await text('docs/API.md');
const auditContract = await text('docs/AUDIT.md');
const securityContract = await text('docs/SECURITY.md');

requireContains(migrationUp, [
  'microsoft365_consent_transactions',
  'microsoft365_consent_actor_fk',
  'microsoft365_consent_integration_fk',
  'state_hash char(64) NOT NULL UNIQUE',
  'ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid',
  "'integration.verified'",
], 'Migration 011 up');

requireContains(migrationDown, [
  'MICROSOFT365_CONNECTION_ROWS_REQUIRE_REVIEW',
  "WHERE action = 'integration.verified'",
  'ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid',
], 'Migration 011 down');
const restoredAuditConstraint = migrationDown.slice(
  migrationDown.lastIndexOf('ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid'),
);
if (restoredAuditConstraint.includes("'integration.verified'")) {
  throw new Error('Migration 011 down must restore the schema-10 audit action constraint.');
}

requireContains(service, [
  'PERMISSION.TENANT_INTEGRATIONS_MANAGE',
  "createHash('sha256')",
  'actorUserId: principal.userId',
  'bindingRepository.findActiveBindingByTenantId',
  'providerTenantReference: binding.providerTenantReference',
  'repository.consumeConsent',
  'connectionVersion: consumed.connectionVersion',
], 'Microsoft 365 application service');

requireContains(providerClient, [
  'APPROVED_OUTBOUND_ORIGINS.microsoftIdentity',
  'APPROVED_OUTBOUND_ORIGINS.microsoftGraph',
  'createBoundedMicrosoftIdentityNetworkClient',
  'requireMicrosoftIdentityUrl',
  'MICROSOFT365_IDENTITY_URL_INVALID',
  'sendPostRequestAsync',
  'boundedIdentityTimeout',
  'PROVIDER_REQUEST_MAX_BYTES',
  'PROVIDER_RESPONSE_MAX_BYTES',
  "redirect: 'error'",
  'AbortSignal.timeout(timeoutMs)',
  "'Place.Read.All'",
  "'Calendars.ReadBasic.All'",
  "'calendars_permission_unverified'",
], 'Microsoft 365 provider client');

requireContains(providerClientTests, [
  'MSAL identity transport is fixed-origin',
  "networkClient.sendPostRequestAsync('https://attacker.example/token'",
  "error.code === 'MICROSOFT365_IDENTITY_REQUEST_INVALID'",
  "error.code === 'MICROSOFT365_RESPONSE_TOO_LARGE'",
  "error.code === 'MICROSOFT365_IDENTITY_UNAVAILABLE'",
], 'Microsoft 365 provider client tests');

requireContains(routes, [
  'CALLBACK_QUERY_KEYS',
  'CALLBACK_VALUE_LIMITS',
  'searchParams.getAll(key)',
  'principalGuard.require(request, { csrf: mutation })',
  'assertEmptyBody(request)',
  "sendRedirect(response, '/?integration=microsoft365_connection_failed')",
], 'Microsoft 365 HTTP boundary');

requireContains(repository, [
  'WHERE tenant_id = $1',
  'pg_advisory_xact_lock',
  'DELETE FROM microsoft365_consent_transactions',
  'AND actor_user_id = $2',
  'AND state_hash = $3',
  'AND expires_at > $4',
  'AND connection_version = $3',
  'appendWithClient(client, event)',
], 'Microsoft 365 PostgreSQL boundary');

requireContains(contract, [
  'one-time server-side consent transaction',
  'Place.Read.All',
  'Calendars.ReadBasic.All',
  'bounded custom MSAL network client',
  'Migration `011_microsoft365_connection_lifecycle`',
], 'Microsoft 365 lifecycle contract');

requireContains(apiContract, [
  'currently version 11',
  'GET /api/v1/integrations/microsoft365',
  'POST /api/v1/integrations/microsoft365/connect',
  'GET /api/v1/integrations/microsoft365/callback',
  'POST /api/v1/integrations/microsoft365/verify',
  'DELETE /api/v1/integrations/microsoft365',
], 'API contract');

requireContains(auditContract, [
  '`integration.verified`',
  'Migration 011 extends the PostgreSQL action constraint',
  'verification evidence remains',
], 'Audit contract');

requireContains(securityContract, [
  '## Microsoft 365 connection controls (#62)',
  'Replay, expiry, actor mismatch, cross-Tenant use',
  'Local disconnect does not claim',
], 'Security contract');

console.log('Microsoft 365 connection lifecycle gate passed.');

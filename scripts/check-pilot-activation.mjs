import { readFile } from 'node:fs/promises';

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!/export const CURRENT_SCHEMA_VERSION = 33;/.test(pool)) {
  throw new Error('Pilot activation requires the integrated SaaS 3 schema version 33.');
}

const service = await readFile('src/application/tenant-pilot-service.js', 'utf8');
for (const required of [
  'authorizationPolicy.requireTenantPermission',
  'PERMISSION.TENANT_INTEGRATIONS_MANAGE',
  'authorizeOperator = async () => false',
  'AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED',
  'tenantRepository.changeStatus',
  "'microsoft.calendar.write'",
]) {
  if (!service.includes(required)) throw new Error(`Tenant pilot service is missing invariant ${required}.`);
}

const readinessPolicy = await readFile('src/tenancy/tenant-readiness-policy.js', 'utf8');
for (const required of ["'microsoft.directory'", "'microsoft.calendar'"]) {
  if (!readinessPolicy.includes(required)) {
    throw new Error(`Canonical Tenant readiness policy is missing activation capability ${required}.`);
  }
}
if (!service.includes('TENANT_ACTIVATION_CAPABILITIES')) {
  throw new Error('Tenant pilot service must consume the canonical activation capability policy.');
}

const index = await readFile('src/index.js', 'utf8');
if (!index.includes('createTenantPilotService') || !index.includes('getPilotReadiness')) {
  throw new Error('Production composition must expose read-only Tenant pilot readiness.');
}
if (/authorizeOperator\s*:/.test(index)) {
  throw new Error('Production composition must keep Tenant lifecycle operator mutation default-deny.');
}

const routes = await readFile('src/http/microsoft365-routes.js', 'utf8');
if (!routes.includes("pilotReadiness: '/api/v1/integrations/microsoft365/pilot-readiness'")) {
  throw new Error('Tenant Admin pilot readiness must remain under the Microsoft integration boundary.');
}
if (!routes.includes('service.getPilotReadiness')) {
  throw new Error('Pilot readiness route must delegate to the server-authoritative service.');
}
if (/pilot-readiness[\s\S]{0,250}(?:POST|PUT|PATCH|DELETE)/.test(routes)) {
  throw new Error('Tenant Admin pilot readiness route must remain read-only.');
}

const repository = await readFile('src/persistence/postgres/tenant-repository.js', 'utf8');
for (const required of [
  'withPostgresTransaction',
  'WHERE id = $1 AND status = $2',
  'auditRepository.appendWithClient(client, auditEvent)',
]) {
  if (!repository.includes(required)) throw new Error(`Tenant lifecycle persistence is missing invariant ${required}.`);
}

const up = await readFile('migrations/016_tenant_pilot_lifecycle.up.sql', 'utf8');
if (!up.includes("'tenant.lifecycle.changed'")) {
  throw new Error('Migration 016 must allow Tenant lifecycle audit evidence.');
}
const down = await readFile('migrations/016_tenant_pilot_lifecycle.down.sql', 'utf8');
if (!down.includes('TENANT_LIFECYCLE_AUDIT_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Migration 016 rollback must fail closed when lifecycle evidence exists.');
}

console.log('Pilot activation architecture and security gate passed.');

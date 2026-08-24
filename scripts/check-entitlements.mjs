import { readFile } from 'node:fs/promises';

const capabilities = await readFile('src/entitlements/capabilities.js', 'utf8');
for (const capability of ['microsoft.directory', 'microsoft.calendar']) {
  if (!capabilities.includes(`'${capability}'`)) {
    throw new Error(`Stable capability registry is missing ${capability}.`);
  }
}
if (!capabilities.includes('authorized && entitled') || !capabilities.includes('ROLLOUT_STATE.DISABLED')) {
  throw new Error('Effective capability evaluation must require authorization and entitlement and honor rollout disablement.');
}

const service = await readFile('src/entitlements/entitlement-service.js', 'utf8');
for (const required of [
  'authorized !== true',
  'principal.tenantId === tenantContext.tenantId',
  "tenantContext.status === 'active'",
  'rolloutPolicy.stateFor(capabilityId)',
  'OPERATOR_NOT_AUTHORIZED',
  'AUDIT_ACTION.TENANT_ENTITLEMENT_CHANGED',
  "actorType: 'platform_operator'",
]) {
  if (!service.includes(required)) throw new Error(`Entitlement service is missing invariant ${required}.`);
}
if (/request\.|headers|searchParams|localStorage|sessionStorage/i.test(service)) {
  throw new Error('Entitlement authority must not depend on browser or transport-controlled state.');
}

const repository = await readFile('src/persistence/postgres/entitlement-repository.js', 'utf8');
for (const required of [
  'WHERE tenant_id = $1',
  'capability_id = $2',
  'pg_advisory_xact_lock',
  'appendWithClient(client',
]) {
  if (!repository.includes(required)) throw new Error(`Entitlement repository is missing invariant ${required}.`);
}

const migration = await readFile('migrations/005_tenant_entitlements.up.sql', 'utf8');
for (const required of [
  'CREATE TABLE tenant_entitlements',
  "'microsoft.directory'",
  "'microsoft.calendar'",
  "'tenant.entitlement.changed'",
]) {
  if (!migration.includes(required)) throw new Error(`Entitlement migration is missing ${required}.`);
}

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!pool.includes('CURRENT_SCHEMA_VERSION = 7')) {
  throw new Error('Runtime schema readiness must include entitlement, booking-reference, and OIDC migrations through version 7.');
}

const audit = await readFile('src/audit/event.js', 'utf8');
if (!audit.includes("TENANT_ENTITLEMENT_CHANGED: 'tenant.entitlement.changed'")) {
  throw new Error('Audit taxonomy must include entitlement changes.');
}

console.log('Entitlement boundary check passed.');

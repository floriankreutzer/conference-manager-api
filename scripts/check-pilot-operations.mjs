import { readFile } from 'node:fs/promises';

const operator = await readFile('scripts/pilot-operator.mjs', 'utf8');
for (const invariant of [
  'createTenantOnboardingService',
  'createTenantPilotService',
  'createEntitlementService',
  'createTenantAdminRecoveryService',
  "'recover-tenant-admin'",
  "context === OPERATOR_CONTEXT",
]) {
  if (!operator.includes(invariant)) throw new Error(`Pilot operator invariant missing: ${invariant}`);
}
for (const prohibited of [
  'createHttpServer',
  '.listen(',
  'http.createServer',
  'https.createServer',
  'SELECT ',
  'INSERT ',
  'UPDATE ',
  'DELETE FROM',
]) {
  if (operator.includes(prohibited)) throw new Error(`Pilot operator must not expose or bypass services: ${prohibited}`);
}

const productionComposition = await readFile('src/index.js', 'utf8');
if (/authorizeOperator\s*:/.test(productionComposition)) {
  throw new Error('Production HTTP composition must keep platform operator mutation default-deny.');
}

const recovery = await readFile('src/application/tenant-admin-recovery-service.js', 'utf8');
for (const invariant of [
  'authorizeOperator(operatorContext',
  "throw new TypeError('RECOVERY_NOT_REQUIRED')",
  'repository.setElevatedRoles',
  'AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED',
  "operation: 'tenant_admin_recovery'",
]) {
  if (!recovery.includes(invariant)) throw new Error(`Tenant Admin recovery invariant missing: ${invariant}`);
}

const runbook = await readFile('docs/MICROSOFT-ENTERPRISE-PILOT-RUNBOOK.md', 'utf8');
for (const required of [
  'The Demo onboarding wizard is an in-memory simulation',
  'npm run pilot:operator -- invite',
  'npm run pilot:operator -- readiness',
  'npm run pilot:operator -- lifecycle',
  'npm run pilot:operator -- entitlement',
  'recover-tenant-admin',
  'Real central multi-tenant app login from at least two independent Entra tenants',
  'Selected EU provider, IaC deployment, restore/rollback evidence (#113)',
  'penetration-test',
]) {
  if (!runbook.includes(required)) throw new Error(`Pilot runbook evidence/control missing: ${required}`);
}

console.log('Pilot operations architecture and evidence gate passed.');

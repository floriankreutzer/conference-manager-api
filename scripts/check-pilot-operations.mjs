import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function filesWithExtension(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesWithExtension(current, extension));
    else if (entry.name.endsWith(extension)) files.push(current);
  }
  return files;
}

async function requireMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Retired Tenant operator path must remain absent: ${path}.`);
}

for (const path of [
  'src/operator/tenant-operator.js',
  'scripts/tenant-operator.mjs',
  'scripts/operator-invitation-artifact.mjs',
  'tests/tenant-operator.test.js',
  'tests/operator-invitation-artifact.test.js',
]) {
  await requireMissing(path);
}

const packageDocument = JSON.parse(await readFile('package.json', 'utf8'));
if (packageDocument.scripts?.['operator:tenant'] !== undefined) {
  throw new Error('The retired operator:tenant package entry point must remain absent.');
}
for (const [name, command] of Object.entries(packageDocument.scripts || {})) {
  if (command.includes('tenant-operator.mjs')) {
    throw new Error(`Package script ${name} must not restore the retired Tenant operator runtime.`);
  }
}

for (const file of await filesWithExtension('src', '.js')) {
  const content = await readFile(file, 'utf8');
  if (
    content.includes('tenant-operator.js')
    || content.includes('TENANT_OPERATOR_COMMAND')
    || content.includes('trusted_tenant_operator_cli')
  ) {
    throw new Error(`Runtime source ${file} must not restore process-local Tenant operator authority.`);
  }
}

const productionComposition = await readFile('src/index.js', 'utf8');
if (/authorizeOperator\s*:/.test(productionComposition)) {
  throw new Error('Customer production composition must keep Platform mutation authority default-deny.');
}

const customerReadinessRoutes = await readFile('src/http/microsoft365-routes.js', 'utf8');
for (const required of [
  "pilotReadiness: '/api/v1/integrations/microsoft365/pilot-readiness'",
  'service.getPilotReadiness',
  'principalGuard.require(request)',
  'tenantGuard.requireKnown(principal)',
]) {
  if (!customerReadinessRoutes.includes(required)) {
    throw new Error(`Customer Pilot readiness route is missing read-only invariant ${required}.`);
  }
}
if (!/path === MICROSOFT365_ROUTES\.pilotReadiness[\s\S]{0,120}request\.method !== 'GET'/.test(customerReadinessRoutes)) {
  throw new Error('Customer Pilot readiness route must reject every method except GET.');
}

const platformReadinessRoutes = await readFile('src/platform/http/readiness-routes.js', 'utf8');
for (const required of [
  "PLATFORM_READINESS_PATH = '/api/v1/platform/readiness'",
  'platformPrincipalGuard.require(request',
  'assertNoPlatformRequestBody(request)',
  'platformFleetReadinessService.listFleetReadiness',
]) {
  if (!platformReadinessRoutes.includes(required)) {
    throw new Error(`Platform readiness route is missing read-only invariant ${required}.`);
  }
}
if (!/path !== PLATFORM_READINESS_PATH[\s\S]{0,120}request\.method !== 'GET'/.test(platformReadinessRoutes)) {
  throw new Error('Platform readiness route must reject every method except GET.');
}

const mutationAuthority = await readFile('src/platform/http/privileged-operation.js', 'utf8');
for (const required of [
  'platformPrincipalGuard.require(request',
  'csrf: true',
  'requirePlatformIdempotencyKey(request)',
]) {
  if (!mutationAuthority.includes(required)) {
    throw new Error(`Platform HTTP mutation authority is missing invariant ${required}.`);
  }
}

for (const [file, required] of [
  ['src/platform/http/tenant-routes.js', [
    'platformMutationAuthority',
    'createTenantInvitation',
    'transitionLifecycle',
  ]],
  ['src/platform/http/entitlement-routes.js', [
    'platformMutationAuthority',
    'applyEntitlementChanges',
    'applyPackage',
  ]],
  ['src/platform/http/recovery-routes.js', [
    'platformMutationAuthority',
    'executeRecovery',
  ]],
]) {
  const content = await readFile(file, 'utf8');
  for (const invariant of required) {
    if (!content.includes(invariant)) {
      throw new Error(`Authenticated Platform mutation route ${file} is missing ${invariant}.`);
    }
  }
}

const evidenceContract = await readFile('src/operator/pilot-readiness-evidence.js', 'utf8');
for (const required of [
  'deployment.provider_region_decision',
  'operations.backup_restore',
  'acceptance.two_entra_tenants',
  'security.deployed_dast',
  'security.penetration_test',
  'security.exchange_application_rbac',
  'PILOT_READINESS_PENDING',
]) {
  if (!evidenceContract.includes(required)) {
    throw new Error(`Pilot readiness evidence contract is missing invariant ${required}.`);
  }
}

const exchangeRbacRuntime = await readFile('scripts/exchange-application-rbac-check.mjs', 'utf8');
const boundedEvidenceReader = await readFile('scripts/lib/bounded-evidence-file.mjs', 'utf8');
if (!exchangeRbacRuntime.includes('readBoundedRegularFile')) {
  throw new Error('Exchange Application RBAC evidence reader must use the bounded file contract.');
}
for (const required of [
  'O_NOFOLLOW',
  'Buffer.allocUnsafe(maxBytes + 1)',
  'file.read(buffer,',
]) {
  if (!boundedEvidenceReader.includes(required)) {
    throw new Error(`Bounded operator evidence reader is missing invariant ${required}.`);
  }
}
if (boundedEvidenceReader.includes('file.readFile')) {
  throw new Error('Operator evidence reader must enforce its bound while reading.');
}

for (const script of [
  'pilot:readiness',
  'pilot:exchange-rbac',
  'check:pilot-operations',
  'check:pilot-readiness',
]) {
  if (typeof packageDocument.scripts?.[script] !== 'string') {
    throw new Error(`Package script ${script} is required.`);
  }
}

const platformFallback = await readFile('scripts/platform-recovery-fallback.mjs', 'utf8');
const platformGrant = await readFile('scripts/platform-break-glass-grant.mjs', 'utf8');
const fixedDescriptor = await readFile('scripts/lib/fixed-descriptor-json.mjs', 'utf8');
for (const required of [
  'readFixedDescriptorJson(3)',
  'executePlatformRecoveryFallback',
  "['pilot', 'production'].includes(config.mode)",
  'persistence.readinessChecks',
]) {
  if (!platformFallback.includes(required)) {
    throw new Error(`Platform recovery fallback is missing invariant ${required}.`);
  }
}
for (const required of [
  'readFixedDescriptorJson(3)',
  'writeSecretToFixedDescriptor(issued.token, 4)',
  'issuePlatformFallbackGrant',
  'persistence.readinessChecks',
]) {
  if (!platformGrant.includes(required)) {
    throw new Error(`Platform grant fallback is missing invariant ${required}.`);
  }
}
if (/process\.argv|process\.env\.[A-Z_]*(?:TOKEN|SESSION|GRANT)/.test(`${platformFallback}\n${platformGrant}`)) {
  throw new Error('Platform fallback credentials must not use arguments or environment variables.');
}
for (const required of ['MAX_BYTES', 'fstatSync', 'readSync', 'writeSync', '0o077']) {
  if (!fixedDescriptor.includes(required)) {
    throw new Error(`Platform fixed-descriptor transport is missing invariant ${required}.`);
  }
}
for (const script of ['operator:platform-grant', 'operator:platform-recovery', 'test:dast:platform']) {
  if (typeof packageDocument.scripts?.[script] !== 'string') {
    throw new Error(`Package script ${script} is required.`);
  }
}

const pilotRunbook = await readFile('docs/PILOT-READINESS-RUNBOOK.md', 'utf8');
for (const required of [
  'No live Pilot evidence is claimed by this document',
  'authenticated Platform Control Plane',
  'Readiness is read-only',
  'grant-bound Platform recovery fallback',
  'Role recovery',
  'Backup, restore, rollback, and escalation',
  'Microsoft Entra and Graph acceptance',
  'Issue #73 remains open',
  'enabledCalendarWriteEvidenceVerified',
  'keep `microsoft.calendar.write` disabled',
  'only after steps 1–4 pass',
  'immediately disable the entitlement',
]) {
  if (!pilotRunbook.includes(required)) {
    throw new Error(`Pilot readiness runbook is missing section ${required}.`);
  }
}

const platformRunbook = await readFile('docs/PLATFORM-OPERATIONS-READINESS-RUNBOOK.md', 'utf8');
for (const required of [
  'All normal mutations use authenticated Platform HTTP',
  'The retired Tenant-operator CLI is not a fallback',
  'npm run operator:platform-grant',
  'npm run operator:platform-recovery',
  'grant consumption, mutation, receipt, dual audit and used-alert',
]) {
  if (!platformRunbook.includes(required)) {
    throw new Error(`Platform operations runbook is missing invariant ${required}.`);
  }
}

const architecture = await readFile('docs/ARCHITECTURE.md', 'utf8');
for (const required of [
  'Platform readiness is read-only',
  'the only local privileged mutation wrappers',
  'dual-control, exact Tenant/permission-bound, one-use grant',
  'retired process-local Tenant-operator runtime and package entry point are prohibited',
]) {
  if (!architecture.includes(required)) {
    throw new Error(`Backend architecture is missing operator-retirement invariant ${required}.`);
  }
}

const readme = await readFile('README.md', 'utf8');
for (const required of [
  'separate authenticated Platform HTTP boundary',
  'the only local mutation fallback is the dual-control, grant-bound recovery wrapper',
]) {
  if (!readme.includes(required)) {
    throw new Error(`Backend overview is missing operator-retirement invariant ${required}.`);
  }
}

for (const file of await filesWithExtension('docs', '.md')) {
  const content = await readFile(file, 'utf8');
  if (content.includes('npm run operator:tenant')) {
    throw new Error(`Documentation ${file} must not advertise the retired Tenant operator entry point.`);
  }
}

console.log('Pilot readiness and authenticated Platform operations architecture gate passed.');

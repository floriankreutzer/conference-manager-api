import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(current));
    else if (entry.name.endsWith('.js')) files.push(current);
  }
  return files;
}

const runtime = await readFile('scripts/tenant-operator.mjs', 'utf8');
for (const required of [
  'assertProductionConfig(config)',
  'config.mode !== command.environment',
  'candidate === operatorContext',
  'persistence.readinessChecks',
  'prepareInvitationArtifact',
  'publicTenantOperatorResult',
]) {
  if (!runtime.includes(required)) {
    throw new Error(`Tenant operator runtime is missing invariant ${required}.`);
  }
}
if (runtime.includes("from '../src/http/")) {
  throw new Error('Tenant operator runtime must not depend on the public HTTP boundary.');
}

const artifact = await readFile('scripts/operator-invitation-artifact.mjs', 'utf8');
for (const required of ['O_NOFOLLOW', 'O_EXCL', '0o600', 'normalizeInvitationResult']) {
  if (!artifact.includes(required)) {
    throw new Error(`Invitation artifact writer is missing invariant ${required}.`);
  }
}
if (/process\.(?:stdout|stderr)/.test(artifact)) {
  throw new Error('Invitation artifact writer must never emit credential material to process streams.');
}

const productionComposition = await readFile('src/index.js', 'utf8');
if (productionComposition.includes('tenant-operator') || /authorizeOperator\s*:/.test(productionComposition)) {
  throw new Error('Public production composition must keep Platform operator mutation default-deny.');
}
for (const file of await javascriptFiles('src/http')) {
  const content = await readFile(file, 'utf8');
  if (content.includes('tenant-operator') || content.includes('TENANT_OPERATOR_COMMAND')) {
    throw new Error(`Public HTTP file ${file} must not expose the trusted operator adapter.`);
  }
}

const commandContract = await readFile('src/operator/tenant-operator.js', 'utf8');
for (const required of [
  'TENANT_OPERATOR_APPLY_REQUIRED',
  'TENANT_OPERATOR_CONFIRMATION_INVALID',
  'isInternalUuid',
  'isKnownCapability',
  'publicTenantOperatorResult',
]) {
  if (!commandContract.includes(required)) {
    throw new Error(`Tenant operator command contract is missing invariant ${required}.`);
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

const packageDocument = JSON.parse(await readFile('package.json', 'utf8'));
for (const script of [
  'operator:tenant',
  'pilot:readiness',
  'check:pilot-operations',
  'check:pilot-readiness',
]) {
  if (typeof packageDocument.scripts?.[script] !== 'string') {
    throw new Error(`Package script ${script} is required.`);
  }
}

const runbook = await readFile('docs/PILOT-READINESS-RUNBOOK.md', 'utf8');
for (const required of [
  'No live Pilot evidence is claimed by this document',
  'Role recovery',
  'Backup, restore, rollback, and escalation',
  'Microsoft Entra and Graph acceptance',
]) {
  if (!runbook.includes(required)) {
    throw new Error(`Pilot readiness runbook is missing section ${required}.`);
  }
}

console.log('Pilot operator and readiness architecture gate passed.');

import { randomUUID } from 'node:crypto';
import { createTenantPilotService } from '../src/application/tenant-pilot-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { CAPABILITY, normalizeCapabilityId } from '../src/entitlements/capabilities.js';
import { createEntitlementService } from '../src/entitlements/entitlement-service.js';
import { createTenantOnboardingService } from '../src/onboarding/tenant-onboarding-service.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';

const OPERATOR_CONTEXT = Object.freeze({ source: 'pilot_operator_cli' });
const LIFECYCLE = new Set(['ready', 'active', 'suspended']);
const BOOLEAN = new Map([['true', true], ['false', false]]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireArgument(name) {
  const value = argument(name);
  if (typeof value !== 'string' || value.length < 1) throw new TypeError(`MISSING_${name.toUpperCase().replaceAll('-', '_')}`);
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const command = process.argv[2];
  if (!['invite', 'readiness', 'lifecycle', 'entitlement'].includes(command)) {
    throw new TypeError('COMMAND_INVALID');
  }
  const config = loadConfig();
  if (!config.databaseUrl) throw new TypeError('DATABASE_URL_REQUIRED');
  const persistence = createPostgresPersistence(config);
  const authorizationPolicy = createAuthorizationPolicy();
  const auditService = createAuditService({
    repository: persistence.auditRepository,
    authorizationPolicy,
  });
  const authorizeOperator = async (context) => context === OPERATOR_CONTEXT;
  const onboarding = createTenantOnboardingService({
    repository: persistence.tenantOnboardingRepository,
    auditService,
    authorizeOperator,
    transactionSecret: config.oidcTransactionSecret,
    publicOrigin: config.publicOrigin,
  });
  const entitlements = createEntitlementService({
    repository: persistence.entitlementRepository,
    auditService,
    authorizeOperator,
  });
  const pilot = createTenantPilotService({
    tenantRepository: persistence.tenantRepository,
    bindingRepository: persistence.tenantOnboardingRepository,
    connectionRepository: persistence.microsoft365ConnectionRepository,
    roomMappingRepository: persistence.microsoft365RoomMappingRepository,
    capabilityHealthRepository: persistence.microsoft365CapabilityHealthRepository,
    entitlementRepository: persistence.entitlementRepository,
    authorizationPolicy,
    auditService,
    authorizeOperator,
  });
  const correlationId = randomUUID();
  try {
    if (command === 'invite') {
      const result = await onboarding.createTenantInvitation({
        operatorContext: OPERATOR_CONTEXT,
        displayName: requireArgument('display-name'),
        correlationId,
      });
      output({
        command,
        tenantId: result.tenantId,
        invitationToken: result.invitationToken,
        expiresAt: result.expiresAt,
        correlationId,
      });
      return;
    }
    const tenantId = requireArgument('tenant-id');
    if (command === 'readiness') {
      const result = await pilot.readinessForTenant(tenantId);
      output({ command, tenantId, readiness: result, correlationId });
      return;
    }
    if (command === 'lifecycle') {
      const status = requireArgument('status');
      if (!LIFECYCLE.has(status)) throw new TypeError('STATUS_INVALID');
      const result = await pilot.setLifecycle({
        operatorContext: OPERATOR_CONTEXT,
        tenantId,
        targetStatus: status,
        correlationId,
      });
      output({ command, tenantId, status: result.status, correlationId });
      return;
    }
    const capabilityId = normalizeCapabilityId(requireArgument('capability'));
    const enabledValue = requireArgument('enabled');
    if (!BOOLEAN.has(enabledValue)) throw new TypeError('ENABLED_INVALID');
    const result = await entitlements.setEntitlement({
      operatorContext: OPERATOR_CONTEXT,
      tenantId,
      capabilityId,
      enabled: BOOLEAN.get(enabledValue),
      correlationId,
    });
    output({
      command,
      tenantId,
      capabilityId: result.capabilityId ?? capabilityId,
      enabled: result.enabled ?? BOOLEAN.get(enabledValue),
      correlationId,
    });
  } finally {
    await persistence.close();
  }
}

main().catch((error) => {
  fail(error?.code || error?.message || 'PILOT_OPERATOR_FAILED');
});

export const PILOT_CAPABILITIES = Object.freeze(Object.values(CAPABILITY));

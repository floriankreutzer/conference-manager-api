import { randomBytes } from 'node:crypto';
import { createTenantPilotService } from '../src/application/tenant-pilot-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { assertProductionConfig, loadConfig } from '../src/config.js';
import { createEntitlementService } from '../src/entitlements/entitlement-service.js';
import { createTenantOnboardingService } from '../src/onboarding/tenant-onboarding-service.js';
import {
  executeTenantOperatorCommand,
  parseTenantOperatorCommand,
  publicTenantOperatorResult,
  TENANT_OPERATOR_COMMAND,
} from '../src/operator/tenant-operator.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { prepareInvitationArtifact } from './operator-invitation-artifact.mjs';

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;

function errorCode(error) {
  const candidate = error?.code || error?.message;
  return SAFE_ERROR_CODE.test(candidate || '') ? candidate : 'TENANT_OPERATOR_COMMAND_FAILED';
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function requirePersistenceReady(persistence) {
  for (const check of persistence.readinessChecks) {
    if (await check() !== true) throw new Error('TENANT_OPERATOR_PERSISTENCE_NOT_READY');
  }
}

function createServices({ config, persistence, operatorContext, invitationToken }) {
  const authorizationPolicy = createAuthorizationPolicy();
  const auditService = createAuditService({
    repository: persistence.auditRepository,
    authorizationPolicy,
  });
  const authorizeOperator = async (candidate) => candidate === operatorContext;
  const onboardingOptions = {
    repository: persistence.tenantOnboardingRepository,
    auditService,
    authorizeOperator,
    transactionSecret: config.oidcTransactionSecret,
    publicOrigin: config.publicOrigin,
  };
  if (invitationToken) onboardingOptions.randomToken = () => invitationToken;

  return Object.freeze({
    onboarding: createTenantOnboardingService(onboardingOptions),
    entitlement: createEntitlementService({
      repository: persistence.entitlementRepository,
      auditService,
      authorizeOperator,
    }),
    pilot: createTenantPilotService({
      tenantRepository: persistence.tenantRepository,
      bindingRepository: persistence.tenantOnboardingRepository,
      connectionRepository: persistence.microsoft365ConnectionRepository,
      roomMappingRepository: persistence.microsoft365RoomMappingRepository,
      capabilityHealthRepository: persistence.microsoft365CapabilityHealthRepository,
      entitlementRepository: persistence.entitlementRepository,
      authorizationPolicy,
      auditService,
      authorizeOperator,
    }),
  });
}

async function main() {
  let artifact = null;
  let invitationCommitted = false;
  let persistence = null;
  try {
    const command = parseTenantOperatorCommand(process.argv.slice(2));
    const config = loadConfig();
    assertProductionConfig(config);
    if (config.mode !== command.environment) {
      throw new Error('TENANT_OPERATOR_ENVIRONMENT_MISMATCH');
    }

    persistence = createPostgresPersistence(config);
    await requirePersistenceReady(persistence);

    if (command.kind === TENANT_OPERATOR_COMMAND.INVITE) {
      artifact = await prepareInvitationArtifact({
        outputPath: command.outputPath,
        tokenFactory: () => randomBytes(32).toString('base64url'),
      });
    }

    const operatorContext = Object.freeze({ source: 'trusted_tenant_operator_cli' });
    const services = createServices({
      config,
      persistence,
      operatorContext,
      invitationToken: artifact?.invitationToken,
    });
    const result = await executeTenantOperatorCommand({ command, operatorContext, services });

    if (artifact) {
      invitationCommitted = true;
      await artifact.finalize({
        invitationResult: result,
        correlationId: command.correlationId,
      });
    }
    writeJson(process.stdout, publicTenantOperatorResult(command, result));
  } catch (error) {
    let failure = error;
    if (artifact && !invitationCommitted) {
      try {
        await artifact.abort();
      } catch (cleanupError) {
        failure = cleanupError;
      }
    }
    writeJson(process.stderr, Object.freeze({
      status: 'failed',
      code: errorCode(failure),
    }));
    process.exitCode = 1;
  } finally {
    try {
      await persistence?.close();
    } catch {
      // The command result remains authoritative; pool shutdown emits no sensitive detail.
    }
  }
}

await main();

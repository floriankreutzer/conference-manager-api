import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLATFORM_RUNTIME_METADATA_STATE,
  PLATFORM_RUNTIME_OPERATIONAL_STATE,
  createPlatformRuntimeStatusService,
} from '../src/platform/application/runtime-status-service.js';
import {
  PLATFORM_PERMISSION,
  createPlatformAuthorizationPolicy,
} from '../src/platform/identity/policy.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = Object.freeze({ operatorId: 'operator-a' });
const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function runtimeRecord({
  environment = 'pilot',
  reference = 'deploy-20260828-1',
  deployedAt = '2026-08-28T11:50:00.000Z',
  observedAt = '2026-08-28T11:59:00.000Z',
  frontend = {},
  api = {},
  schema = {},
  dependencies = {},
  evidence = {},
  extra = {},
} = {}) {
  return {
    environment,
    deployment: { reference, deployedAt },
    frontend: {
      environment,
      deploymentReference: reference,
      expectedVersion: '3.0.0',
      expectedBuildId: 'web-a1',
      version: '3.0.0',
      buildId: 'web-a1',
      ...frontend,
    },
    api: {
      environment,
      deploymentReference: reference,
      expectedVersion: '3.0.0',
      expectedBuildId: 'api-a1',
      version: '3.0.0',
      buildId: 'api-a1',
      ...api,
    },
    schema: {
      environment,
      deploymentReference: reference,
      expectedVersion: 28,
      currentVersion: 28,
      ...schema,
    },
    dependencies: {
      environment,
      deploymentReference: reference,
      required: 'ready',
      optional: 'ready',
      ...dependencies,
    },
    observedAt,
    evidence: {
      release: 'release:saas3-rc1',
      change: 'github:pr:150',
      rollback: 'change:rollback:150',
      runbook: 'docs:platform-operations#rollback',
      ...evidence,
    },
    ...extra,
  };
}

function harness({
  records = [runtimeRecord()],
  tenantResult = { tenantId: TENANT_A, runtime: runtimeRecord() },
  permissionPolicy = null,
  authorize = () => true,
  authorizeTenant = () => true,
  maxFreshnessAgeMs = 5 * 60 * 1_000,
} = {}) {
  const calls = [];
  const service = createPlatformRuntimeStatusService({
    repository: {
      async listApprovedDeployments({ auditEventFor }) {
        calls.push(['listApprovedDeployments']);
        auditEventFor({ resultCount: records.length });
        return records;
      },
      async findServingDeploymentByTenantId(tenantId, { auditEventFor }) {
        calls.push(['findServingDeploymentByTenantId', tenantId]);
        auditEventFor({ correlationState: tenantResult === null ? 'unknown' : 'mapped' });
        return tenantResult;
      },
    },
    authorizationPolicy: permissionPolicy || {
      async authorize(principal, permission) {
        calls.push(['authorize', principal, permission]);
        return authorize(principal, permission);
      },
    },
    tenantTargetPolicy: {
      async authorize(principal, tenantId) {
        calls.push(['authorizeTenant', principal, tenantId]);
        return authorizeTenant(principal, tenantId);
      },
    },
    auditService: {
      createEvent(input) {
        calls.push(['createAuditEvent', input]);
        return Object.freeze({ ...input, audit: true });
      },
    },
    clock: () => NOW,
    maxFreshnessAgeMs,
  });
  return { calls, service };
}

test('runtime list projects current build, deployment, schema and aggregate dependency state', async () => {
  const values = harness();
  const result = await values.service.listApprovedDeployments({ operatorContext: PRINCIPAL });
  assert.equal(values.calls[0][0], 'authorize');
  assert.equal(values.calls[0][2], PLATFORM_PERMISSION.RUNTIME_READ);
  assert.equal(values.calls[1][0], 'listApprovedDeployments');
  assert.equal(result.deployments.length, 1);
  const audit = values.calls.find(([name]) => name === 'createAuditEvent')[1];
  assert.equal(audit.action, 'platform.runtime.read');
  assert.equal(audit.targetId, 'approved');
  assert.equal(audit.metadata.resultCount, 1);
  const runtime = result.deployments[0];
  assert.equal(runtime.environment, 'pilot');
  assert.deepEqual(runtime.deployment, {
    reference: 'deploy-20260828-1',
    deployedAt: '2026-08-28T11:50:00.000Z',
  });
  assert.equal(runtime.components.frontend.state, PLATFORM_RUNTIME_METADATA_STATE.CURRENT);
  assert.equal(runtime.components.api.state, PLATFORM_RUNTIME_METADATA_STATE.CURRENT);
  assert.equal(runtime.databaseSchema.state, PLATFORM_RUNTIME_METADATA_STATE.CURRENT);
  assert.equal(runtime.dependencies.state, PLATFORM_RUNTIME_OPERATIONAL_STATE.READY);
  assert.equal(runtime.metadataState, PLATFORM_RUNTIME_METADATA_STATE.CURRENT);
  assert.equal(runtime.overallState, 'ready');
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.reasonCodes), true);
});

test('runtime state distinguishes degradation, core failure, mismatch, staleness and unknown', async () => {
  const records = [
    runtimeRecord({
      reference: 'deploy-degraded',
      dependencies: { optional: 'degraded' },
    }),
    runtimeRecord({
      reference: 'deploy-not-ready',
      dependencies: { required: 'not_ready' },
    }),
    runtimeRecord({
      reference: 'deploy-mismatch',
      api: { buildId: 'api-unexpected' },
    }),
    runtimeRecord({
      reference: 'deploy-stale',
      deployedAt: '2026-08-28T10:50:00.000Z',
      observedAt: '2026-08-28T11:00:00.000Z',
    }),
    runtimeRecord({
      reference: 'deploy-unknown',
      frontend: { version: null },
    }),
  ];
  const result = await harness({ records }).service.listApprovedDeployments({ operatorContext: PRINCIPAL });
  assert.deepEqual(result.deployments.map(({ overallState }) => overallState), [
    'degraded',
    'not_ready',
    'mismatch',
    'stale',
    'unknown',
  ]);
  assert.equal(result.deployments[0].operationalState, PLATFORM_RUNTIME_OPERATIONAL_STATE.DEGRADED);
  assert.equal(result.deployments[1].operationalState, PLATFORM_RUNTIME_OPERATIONAL_STATE.NOT_READY);
  assert.equal(result.deployments[2].reasonCodes.includes('api_version_mismatch'), true);
  assert.equal(result.deployments[3].reasonCodes.includes('runtime_observation_stale'), true);
  assert.equal(result.deployments[4].reasonCodes.includes('frontend_metadata_missing'), true);
});

test('runtime severity precedence preserves known failures over incomplete secondary metadata', async () => {
  const result = await harness({
    records: [
      runtimeRecord({
        reference: 'deploy-core-failure-and-unknown',
        dependencies: { required: 'not_ready', optional: 'unknown' },
        frontend: { version: null },
      }),
      runtimeRecord({
        reference: 'deploy-mismatch-and-unknown',
        api: { buildId: 'unexpected' },
        dependencies: { optional: 'unknown' },
      }),
      runtimeRecord({
        reference: 'deploy-stale-and-unknown',
        deployedAt: '2026-08-28T10:50:00.000Z',
        observedAt: '2026-08-28T11:00:00.000Z',
        dependencies: { optional: 'unknown' },
      }),
    ],
  }).service.listApprovedDeployments({ operatorContext: PRINCIPAL });
  assert.deepEqual(result.deployments.map(({ overallState }) => overallState), [
    'not_ready',
    'mismatch',
    'stale',
  ]);
});

test('permission denial prevents runtime repository access for customer or unknown Principals', async () => {
  const values = harness({
    authorize() {
      throw new Error('PLATFORM_AUTHORIZATION_DENIED');
    },
  });
  await assert.rejects(
    values.service.listApprovedDeployments({ operatorContext: { roles: ['tenant_admin'] } }),
    { message: 'PLATFORM_AUTHORIZATION_DENIED' },
  );
  assert.equal(values.calls.some(([name]) => name === 'listApprovedDeployments'), false);
});

test('runtime reads accept only the dedicated canonical Platform permission', async () => {
  const allowed = harness({ permissionPolicy: createPlatformAuthorizationPolicy() });
  await allowed.service.listApprovedDeployments({
    operatorContext: {
      permissions: [PLATFORM_PERMISSION.RUNTIME_READ],
      assurance: { level: 'mfa' },
    },
  });
  assert.equal(allowed.calls.some(([name]) => name === 'listApprovedDeployments'), true);

  const denied = harness({ permissionPolicy: createPlatformAuthorizationPolicy() });
  await assert.rejects(
    denied.service.listApprovedDeployments({
      operatorContext: {
        permissions: [PLATFORM_PERMISSION.DIAGNOSTICS_READ],
        assurance: { level: 'mfa' },
      },
    }),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_AUTHORIZATION_DENIED' },
  );
  assert.equal(denied.calls.some(([name]) => name === 'listApprovedDeployments'), false);

  const ambiguous = harness({ authorize: () => false });
  await assert.rejects(
    ambiguous.service.listApprovedDeployments({ operatorContext: PRINCIPAL }),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_OPERATION_DENIED' },
  );
  assert.equal(ambiguous.calls.some(([name]) => name === 'listApprovedDeployments'), false);
});

test('Tenant correlation requires separate target authorization and no deployment selector', async () => {
  const values = harness();
  const result = await values.service.getServingDeploymentForTenant({
    operatorContext: PRINCIPAL,
    tenantId: TENANT_A,
  });
  assert.deepEqual(values.calls.slice(0, 3).map(([name]) => name), [
    'authorize',
    'authorizeTenant',
    'findServingDeploymentByTenantId',
  ]);
  assert.equal(result.correlationState, 'mapped');
  assert.equal(result.tenantId, TENANT_A);
  assert.equal(result.runtime.deployment.reference, 'deploy-20260828-1');
  const audit = values.calls.find(([name]) => name === 'createAuditEvent')[1];
  assert.equal(audit.action, 'platform.runtime.read');
  assert.equal(audit.targetTenantId, TENANT_A);
  assert.equal(audit.metadata.correlationState, 'mapped');

  await assert.rejects(
    values.service.getServingDeploymentForTenant({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      deploymentReference: 'attacker-selected',
    }),
    { message: 'PLATFORM_RUNTIME_TENANT_LOOKUP_INPUT_INVALID' },
  );

  const denied = harness({
    authorizeTenant() {
      throw new Error('PLATFORM_TENANT_TARGET_DENIED');
    },
  });
  await assert.rejects(
    denied.service.getServingDeploymentForTenant({ operatorContext: PRINCIPAL, tenantId: TENANT_B }),
    { message: 'PLATFORM_TENANT_TARGET_DENIED' },
  );
  assert.equal(denied.calls.some(([name]) => name === 'findServingDeploymentByTenantId'), false);

  const falseDecision = harness({ authorizeTenant: () => false });
  await assert.rejects(
    falseDecision.service.getServingDeploymentForTenant({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_B,
    }),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_OPERATION_DENIED' },
  );
  assert.equal(
    falseDecision.calls.some(([name]) => name === 'findServingDeploymentByTenantId'),
    false,
  );
});

test('missing Tenant routing is explicit and a cross-Tenant repository result fails closed', async () => {
  const missing = harness({ tenantResult: null });
  assert.deepEqual(
    await missing.service.getServingDeploymentForTenant({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
    }),
    {
      schemaVersion: 1,
      tenantId: TENANT_A,
      correlationState: 'unknown',
      runtime: null,
    },
  );

  const mismatched = harness({
    tenantResult: { tenantId: TENANT_B, runtime: runtimeRecord() },
  });
  await assert.rejects(
    mismatched.service.getServingDeploymentForTenant({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
    }),
    { message: 'PLATFORM_RUNTIME_TENANT_SCOPE_MISMATCH' },
  );
});

test('environment or deployment mix-ups are explicit mismatches, never healthy metadata', async () => {
  const result = await harness({
    records: [runtimeRecord({
      frontend: { environment: 'production' },
      schema: { deploymentReference: 'different-deployment' },
    })],
  }).service.listApprovedDeployments({ operatorContext: PRINCIPAL });
  const runtime = result.deployments[0];
  assert.equal(runtime.metadataState, PLATFORM_RUNTIME_METADATA_STATE.MISMATCH);
  assert.equal(runtime.overallState, 'mismatch');
  assert.equal(runtime.reasonCodes.includes('frontend_environment_mismatch'), true);
  assert.equal(runtime.reasonCodes.includes('schema_deployment_mismatch'), true);
});

test('strict runtime DTOs reject hosts, raw URLs and unexpected sensitive fields', async () => {
  const withHost = harness({ records: [runtimeRecord({ extra: { hostname: 'db.internal' } })] });
  await assert.rejects(
    withHost.service.listApprovedDeployments({ operatorContext: PRINCIPAL }),
    { message: 'PLATFORM_RUNTIME_RECORD_INVALID' },
  );

  const withSecret = harness({
    records: [runtimeRecord({ api: { connectionString: 'postgres://secret' } })],
  });
  await assert.rejects(
    withSecret.service.listApprovedDeployments({ operatorContext: PRINCIPAL }),
    { message: 'PLATFORM_RUNTIME_COMPONENT_INVALID' },
  );

  const withUrl = harness({
    records: [runtimeRecord({ evidence: { runbook: 'https://ops.example.invalid/runbook' } })],
  });
  await assert.rejects(
    withUrl.service.listApprovedDeployments({ operatorContext: PRINCIPAL }),
    { message: 'PLATFORM_RUNTIME_EVIDENCE_REFERENCE_INVALID' },
  );
});

test('missing and future observations are unknown rather than apparently healthy', async () => {
  const result = await harness({
    records: [
      runtimeRecord({ reference: 'deploy-missing-observation', observedAt: null }),
      runtimeRecord({
        reference: 'deploy-future-observation',
        observedAt: '2026-08-28T12:00:00.001Z',
      }),
    ],
  }).service.listApprovedDeployments({ operatorContext: PRINCIPAL });
  assert.deepEqual(result.deployments.map(({ metadataState }) => metadataState), [
    PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN,
    PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN,
  ]);
  assert.deepEqual(result.deployments.map(({ overallState }) => overallState), [
    'unknown',
    'unknown',
  ]);
});

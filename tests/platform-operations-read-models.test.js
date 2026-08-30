import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformFleetReadinessService } from '../src/platform/application/fleet-readiness-service.js';
import { createPlatformMicrosoftFleetHealthService } from '../src/platform/application/microsoft-fleet-health-service.js';
import { createPlatformDiagnosticOperationsService } from '../src/platform/application/diagnostic-operations-service.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';
import {
  evaluateTenantReadinessSnapshot,
  TENANT_READINESS_CHECK,
} from '../src/tenancy/tenant-readiness-policy.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const LOOKUP_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-08-28T12:00:00.000Z';
const OBSERVED = '2026-08-28T11:00:00.000Z';
const FRESH = '2026-08-28T13:00:00.000Z';
const STALE = '2026-08-28T11:30:00.000Z';

function authorizationPolicy(permissions) {
  return {
    authorize(_principal, permission) {
      permissions.push(permission);
      return true;
    },
  };
}

function targetPolicy(scope = { mode: 'all', securityVersion: 1, scopeKey: 'all-1' }) {
  return {
    async authorize() { return true; },
    async queryScope() { return scope; },
  };
}

test('shared readiness projection distinguishes blocked, stale, and unknown without browser flags', () => {
  const blocked = evaluateTenantReadinessSnapshot({
    asOfMs: Date.parse(NOW),
    requiredCheckIds: [
      TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
    ],
    checks: [
      {
        checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
        category: 'identity',
        state: 'fail',
        reasonCode: 'tenant.identity.inactive',
        observedAt: OBSERVED,
        freshUntil: FRESH,
      },
      {
        checkId: TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
        category: 'capability_health',
        state: 'pass',
        reasonCode: null,
        observedAt: OBSERVED,
        freshUntil: STALE,
      },
    ],
  });
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.blockerCodes, [
    'microsoft.free_busy.healthy.stale',
    'tenant.identity.inactive',
  ]);

  const unknown = evaluateTenantReadinessSnapshot({
    asOfMs: Date.parse(NOW),
    requiredCheckIds: [
      TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
    ],
    checks: [{
      checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      category: 'identity',
      state: 'pass',
      reasonCode: null,
      observedAt: OBSERVED,
      freshUntil: FRESH,
    }],
  });
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.blockerCodes, ['microsoft.free_busy.healthy.unknown']);
});

test('fleet readiness is a bounded authoritative snapshot and redacts provider data', async () => {
  const permissions = [];
  const service = createPlatformFleetReadinessService({
    readinessSnapshotReader: {
      async list() {
        return {
          snapshotAt: NOW,
          nextCursor: null,
          items: [{
            tenantId: TENANT_ID,
            displayName: 'Northwind',
            lifecycleStatus: 'ready',
            lifecycleRevision: 4,
            onboardingState: 'complete',
            enabledEntitlementCount: 2,
            missingRequiredEntitlementCount: 0,
            checks: [
              {
                checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
                category: 'identity',
                state: 'pass',
                reasonCode: null,
                observedAt: OBSERVED,
                freshUntil: FRESH,
              },
              {
                checkId: TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
                category: 'capability_health',
                state: 'pass',
                reasonCode: null,
                observedAt: OBSERVED,
                freshUntil: STALE,
              },
            ],
            evidence: [
              { kind: 'repository', state: 'verified', release: '1.2.3', verifiedAt: OBSERVED, validUntil: FRESH },
              { kind: 'deployment', state: 'verified', release: '1.2.3', verifiedAt: OBSERVED, validUntil: FRESH },
              { kind: 'external', state: 'unknown', release: null, verifiedAt: null, validUntil: null },
            ],
            providerTenantReference: 'must-not-leak',
          }],
        };
      },
    },
    readinessPolicy: {
      requiredCheckIds() {
        return [TENANT_READINESS_CHECK.IDENTITY_ACTIVE, TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY];
      },
      evaluateSnapshot({ checks, asOfMs }) {
        return evaluateTenantReadinessSnapshot({
          checks,
          requiredCheckIds: [
            TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
            TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
          ],
          asOfMs,
        });
      },
    },
    platformAuthorizationPolicy: authorizationPolicy(permissions),
    tenantTargetPolicy: targetPolicy(),
    clock: () => Date.parse(NOW),
  });
  const result = await service.listFleetReadiness({ operatorContext: {}, query: { limit: 10 } });
  assert.equal(permissions[0], PLATFORM_PERMISSION.READINESS_READ);
  assert.equal(result.items[0].readiness.state, 'stale');
  assert.doesNotMatch(JSON.stringify(result), /providerTenantReference|must-not-leak/);
});

test('Microsoft fleet health reads persisted snapshots only and emits a minimized projection', async () => {
  const permissions = [];
  let snapshotReads = 0;
  const service = createPlatformMicrosoftFleetHealthService({
    healthSnapshotReader: {
      async list() {
        snapshotReads += 1;
        return {
          snapshotAt: NOW,
          nextCursor: null,
          items: [{
            tenantId: TENANT_ID,
            displayName: 'Northwind',
            lifecycleStatus: 'active',
            lifecycleRevision: 5,
            connectionState: 'degraded',
            placesPermission: 'granted',
            calendarsPermission: 'granted',
            activeMappingCount: 4,
            missingMappingCount: 1,
            totalMappingCount: 5,
            capabilities: [{
              capability: 'free_busy',
              status: 'degraded',
              reasonCode: 'provider_throttled',
              checkedAt: OBSERVED,
              lastSuccessAt: OBSERVED,
              freshUntil: STALE,
              incidentScope: 'provider',
              rawProviderError: 'must-not-leak',
            }],
            integrationId: 'must-not-leak',
            providerTenantReference: 'must-not-leak',
          }],
        };
      },
    },
    platformAuthorizationPolicy: authorizationPolicy(permissions),
    tenantTargetPolicy: targetPolicy(),
    healthPresentationPolicy: {
      async contract() {
        return {
          capabilities: ['places', 'free_busy', 'calendar_write'],
          connectionStates: ['not_configured', 'connected', 'degraded', 'disconnected'],
          permissionStates: ['granted', 'missing', 'unknown'],
          healthStatuses: [
            'healthy',
            'degraded',
            'unavailable',
            'revoked',
            'permission_missing',
            'not_configured',
            'unknown',
          ],
          incidentScopes: ['provider', 'tenant', 'unknown'],
        };
      },
    },
    clock: () => Date.parse(NOW),
  });
  assert.deepEqual(Object.keys(service), ['listFleetHealth']);
  const result = await service.listFleetHealth({ operatorContext: {}, query: {} });
  assert.equal(snapshotReads, 1);
  assert.equal(permissions[0], PLATFORM_PERMISSION.INTEGRATION_HEALTH_READ);
  assert.equal(result.items[0].capabilities[0].freshness, 'stale');
  assert.equal(result.items[0].capabilities[0].incidentScope, 'provider');
  assert.doesNotMatch(JSON.stringify(result), /integrationId|providerTenantReference|rawProviderError|must-not-leak/);
});

test('diagnostics use tenant-bound, time-bound audited reads and discard raw data', async () => {
  const permissions = [];
  const calls = [];
  const service = createPlatformDiagnosticOperationsService({
    diagnosticReader: {
      async readSummaryAndRecordAccess(values) {
        calls.push(['summary', values]);
        return {
          tenantId: TENANT_ID,
          displayName: 'Northwind',
          lifecycleStatus: 'active',
          lifecycleRevision: 8,
          readinessState: 'blocked',
          readinessBlockerCodes: ['provider_throttled'],
          readinessEvaluatedAt: NOW,
          entitlementRevision: 4,
          enabledEntitlementCount: 2,
          connectionState: 'degraded',
          healthState: 'degraded',
          healthFreshness: 'fresh',
          healthLastCheckedAt: NOW,
          activeMappingCount: 4,
          missingMappingCount: 1,
          totalMappingCount: 5,
          deployedRelease: '1.2.3+abc',
          deploymentObservedAt: NOW,
          recentFailures: [{ category: 'provider_throttled', occurredAt: NOW, rawPayload: 'must-not-leak' }],
          requestBody: 'must-not-leak',
          providerTenantReference: 'must-not-leak',
        };
      },
      async queryTenantCorrelationAndRecordAccess(values) {
        calls.push(['correlation', values]);
        return [{
          source: 'tenant_audit',
          occurredAt: NOW,
          action: 'tenant.lifecycle.changed',
          outcome: 'success',
          category: null,
          targetType: 'tenant',
          targetId: 'must-not-leak',
          metadata: { token: 'must-not-leak' },
        }];
      },
    },
    platformAuthorizationPolicy: authorizationPolicy(permissions),
    tenantTargetPolicy: targetPolicy(),
    operationEvidenceFactory: {
      async createSensitiveRead(values) { return { auditEvent: values }; },
    },
    clock: () => Date.parse(NOW),
  });
  const summary = await service.getTenantSummary({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
  });
  assert.equal(summary.summary.tenant.tenantId, TENANT_ID);
  assert.doesNotMatch(JSON.stringify(summary), /providerTenantReference|requestBody|rawPayload|must-not-leak/);

  const correlation = await service.lookupCorrelation({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    lookupCorrelationId: LOOKUP_ID,
    from: '2026-08-27T12:00:00.000Z',
    to: NOW,
    limit: 20,
  });
  assert.equal(permissions.at(-1), PLATFORM_PERMISSION.DIAGNOSTICS_SENSITIVE);
  assert.equal(calls[1][1].tenantId, TENANT_ID);
  assert.equal(calls[1][1].lookupCorrelationId, LOOKUP_ID);
  assert.doesNotMatch(JSON.stringify(correlation), /targetId|metadata|token|must-not-leak/);
});

test('diagnostic correlation windows are bounded before any repository query', async () => {
  let reads = 0;
  const service = createPlatformDiagnosticOperationsService({
    diagnosticReader: {
      async readSummaryAndRecordAccess() { reads += 1; },
      async queryTenantCorrelationAndRecordAccess() { reads += 1; return []; },
    },
    platformAuthorizationPolicy: authorizationPolicy([]),
    tenantTargetPolicy: targetPolicy(),
    operationEvidenceFactory: { async createSensitiveRead() { return {}; } },
    clock: () => Date.parse(NOW),
  });
  await assert.rejects(service.lookupCorrelation({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    lookupCorrelationId: LOOKUP_ID,
    from: '2026-06-01T00:00:00.000Z',
    to: NOW,
    limit: 20,
  }), /PLATFORM_DIAGNOSTIC_TIME_RANGE_INVALID/);
  assert.equal(reads, 0);
});

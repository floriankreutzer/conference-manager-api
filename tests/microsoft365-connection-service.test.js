import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createMicrosoft365ConnectionService,
} from '../src/application/microsoft365-connection-service.js';
import {
  Microsoft365ConnectionConflictError,
} from '../src/application/microsoft365-connection-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { MICROSOFT365_VERIFICATION } from '../src/integrations/microsoft365-client.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '11111111-1111-4111-8111-111111111112';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROVIDER_TENANT_ID = '33333333-3333-4333-8333-333333333334';
const PROVIDER_USER_ID = '44444444-4444-4444-8444-444444444444';
const INTEGRATION_ID = '55555555-5555-4555-8555-555555555555';
const TRANSACTION_ID = '66666666-6666-4666-8666-666666666666';
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777';
const STATE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = Date.parse('2026-08-25T06:30:00.000Z');

const tenantContext = Object.freeze({ tenantId: TENANT_ID, status: 'onboarding' });

function principal(overrides = {}) {
  return {
    userId: ADMIN_ID,
    tenantId: TENANT_ID,
    roles: ['employee', 'tenant_admin'],
    permissions: [
      'request:read',
      'request:cancel',
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
    ...overrides,
  };
}

function storedConnection(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    providerTenantReference: PROVIDER_TENANT_ID,
    status: 'connected',
    connectionVersion: 1,
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    reason: null,
    lastVerifiedAt: '2026-08-25T06:00:00.000Z',
    updatedAt: '2026-08-25T06:00:00.000Z',
    ...overrides,
  };
}

function createHarness({
  connection: initialConnection = null,
  binding = {},
  consumeResult,
  finalizeResult,
  startResult,
  verification = {
    status: MICROSOFT365_VERIFICATION.CONNECTED,
    places: 'granted',
    calendars: 'granted',
    reason: null,
  },
} = {}) {
  const capture = {
    audit: [],
    denied: [],
    bindings: [],
    starts: [],
    consumes: [],
    finalizes: [],
    disconnects: [],
    providerVerifications: [],
    recorded: [],
  };
  let connection = initialConnection;
  const identifiers = [INTEGRATION_ID, TRANSACTION_ID];

  const auditService = {
    createEvent({ principal: actor, tenantContext: context, ...value }) {
      const event = Object.freeze({
        tenantId: context.tenantId,
        actorUserId: actor.userId,
        ...value,
      });
      capture.audit.push(event);
      return event;
    },
    async recordAuthorizationDenied(value) {
      capture.denied.push(value);
      return value;
    },
    async record(value) {
      capture.recorded.push(value);
      return value;
    },
  };

  const repository = {
    async findByTenantId(tenantId) {
      assert.equal(tenantId, TENANT_ID);
      return connection;
    },
    async startConsent(value) {
      capture.starts.push(value);
      if (startResult !== undefined) return startResult;
      capture.audit.push(value.auditEventFor({
        integrationId: INTEGRATION_ID,
        previousStatus: connection?.status ?? null,
        nextStatus: connection?.status ?? 'pending',
        providerRebound: false,
      }));
      return { status: 'pending', integrationId: INTEGRATION_ID, connectionVersion: 1 };
    },
    async consumeConsent(value) {
      capture.consumes.push(value);
      const result = consumeResult === undefined
        ? {
          status: 'consumed',
          integrationId: INTEGRATION_ID,
          providerTenantReference: PROVIDER_TENANT_ID,
          connectionVersion: 1,
          connectionStatus: connection?.status ?? 'pending',
          lastVerifiedAt: connection?.lastVerifiedAt ?? null,
          connectionReason: connection?.reason ?? null,
          placesPermission: connection?.placesPermission ?? 'unknown',
          calendarsPermission: connection?.calendarsPermission ?? 'unknown',
        }
        : consumeResult;
      if (result?.status === 'rejected') {
        capture.audit.push(value.rejectionAuditEventFor({
          integrationId: null,
          previousStatus: null,
          reasonCode: result.reason,
        }));
      }
      return result;
    },
    async finalizeConsent(value) {
      capture.finalizes.push(value);
      if (finalizeResult !== undefined) return finalizeResult;
      connection = storedConnection({
        status: value.status,
        connectionVersion: value.connectionVersion,
        placesPermission: value.placesPermission,
        calendarsPermission: value.calendarsPermission,
        reason: value.reason,
        lastVerifiedAt: value.lastVerifiedAt?.toISOString() ?? null,
        updatedAt: value.changedAt.toISOString(),
      });
      return { status: 'updated', connection };
    },
    async disconnect(value) {
      capture.disconnects.push(value);
      if (!connection) return null;
      if (connection.status === 'disconnected') return connection;
      capture.audit.push(value.auditEventFor({
        integrationId: INTEGRATION_ID,
        previousStatus: connection.status,
        nextStatus: 'disconnected',
      }));
      connection = storedConnection({
        status: 'disconnected',
        connectionVersion: connection.connectionVersion + 1,
        placesPermission: 'unknown',
        calendarsPermission: 'unknown',
        reason: null,
        lastVerifiedAt: null,
        updatedAt: value.changedAt.toISOString(),
      });
      return connection;
    },
  };

  const bindingRepository = {
    async findActiveBindingByTenantId(tenantId, provider) {
      capture.bindings.push({ tenantId, provider });
      if (binding === null) return null;
      return {
        tenantId,
        provider,
        providerTenantReference: PROVIDER_TENANT_ID,
        claimantProviderUserReference: PROVIDER_USER_ID,
        status: 'active',
        ...binding,
      };
    },
  };

  const providerClient = {
    adminConsentUrl({ tenantReference, state }) {
      assert.equal(tenantReference, PROVIDER_TENANT_ID);
      return `https://login.microsoftonline.com/${tenantReference}/v2.0/adminconsent?state=${state}`;
    },
    async verifyBasePermissions(value) {
      capture.providerVerifications.push(value);
      return verification;
    },
  };

  return {
    capture,
    service: createMicrosoft365ConnectionService({
      repository,
      bindingRepository,
      authorizationPolicy: createAuthorizationPolicy(),
      auditService,
      providerClient,
      clock: () => NOW,
      idFactory: () => identifiers.shift(),
      stateFactory: () => STATE,
    }),
  };
}

test('connection read returns a safe disconnected baseline and rejects Employee access', async () => {
  const { service, capture } = createHarness();
  assert.deepEqual(await service.getConnection({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
  }), {
    status: 'disconnected',
    placesPermission: 'unknown',
    calendarsPermission: 'unknown',
    reason: null,
    lastVerifiedAt: null,
    requiredPermissions: ['Place.Read.All', 'Calendars.ReadBasic.All'],
  });

  const employee = principal({
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  });
  await assert.rejects(
    service.getConnection({
      principal: employee,
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(capture.denied.length, 1);
  assert.equal(capture.denied[0].metadata.operation, 'read');
});

test('connection start derives the provider tenant from the active binding and stores only a state hash', async () => {
  const { service, capture } = createHarness();
  const result = await service.startConnection({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
  });

  assert.match(result.authorizationUrl, /^https:\/\/login\.microsoftonline\.com\//);
  assert.equal(result.expiresAt, '2026-08-25T06:40:00.000Z');
  assert.deepEqual(capture.bindings, [{
    tenantId: TENANT_ID,
    provider: 'microsoft_entra',
  }]);
  assert.equal(capture.starts[0].tenantId, TENANT_ID);
  assert.equal(capture.starts[0].actorUserId, ADMIN_ID);
  assert.equal(capture.starts[0].providerTenantReference, PROVIDER_TENANT_ID);
  assert.equal(capture.starts[0].stateHash, createHash('sha256').update(STATE).digest('hex'));
  assert.equal(JSON.stringify(capture.starts[0]).includes(STATE), false);
  assert.equal(capture.audit.at(-1).action, 'integration.admin_consent.changed');
});

test('provider rebind is rejected while booking references require reconciliation', async () => {
  const { service, capture } = createHarness({
    startResult: { status: 'booking_reconciliation_required' },
  });
  await assert.rejects(
    service.startConnection({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof Microsoft365ConnectionConflictError
      && error.code === 'MICROSOFT365_BOOKING_RECONCILIATION_REQUIRED',
  );
  assert.equal(capture.starts.length, 1);
  assert.equal(capture.audit.length, 0);
});

test('successful consent is one-time, binding-consistent, verified and audit-atomic', async () => {
  const { service, capture } = createHarness();
  const connection = await service.completeConsent({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
    state: STATE,
    providerTenantReference: PROVIDER_TENANT_ID.toUpperCase(),
    approved: true,
  });

  assert.equal(capture.consumes[0].tenantId, TENANT_ID);
  assert.equal(capture.consumes[0].actorUserId, ADMIN_ID);
  assert.equal(capture.consumes[0].callbackProviderTenantReference, PROVIDER_TENANT_ID);
  assert.equal(capture.providerVerifications.length, 1);
  assert.deepEqual(capture.providerVerifications[0], {
    tenantReference: PROVIDER_TENANT_ID,
    claimantUserReference: PROVIDER_USER_ID,
  });
  assert.equal(capture.finalizes[0].status, 'connected');
  assert.equal(capture.finalizes[0].placesPermission, 'granted');
  assert.equal(capture.finalizes[0].calendarsPermission, 'granted');
  assert.deepEqual(
    capture.finalizes[0].auditEvents.map((event) => event.action),
    ['integration.admin_consent.changed', 'integration.connected'],
  );
  assert.equal(Object.hasOwn(connection, 'integrationId'), false);
  assert.equal(Object.hasOwn(connection, 'providerTenantReference'), false);
  assert.equal(connection.status, 'connected');
});

test('callback tenant mismatch is rejected and a replayed consent state cannot be reused', async () => {
  const mismatch = createHarness();
  await assert.rejects(
    mismatch.service.completeConsent({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
      state: STATE,
      providerTenantReference: OTHER_PROVIDER_TENANT_ID,
      approved: true,
    }),
    (error) => error instanceof Microsoft365ConnectionConflictError
      && error.code === 'MICROSOFT365_PROVIDER_TENANT_MISMATCH',
  );
  assert.equal(mismatch.capture.providerVerifications.length, 0);

  const replay = createHarness({
    consumeResult: { status: 'rejected', reason: 'consent_unavailable' },
  });
  await assert.rejects(
    replay.service.completeConsent({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
      state: STATE,
      providerTenantReference: PROVIDER_TENANT_ID,
      approved: true,
    }),
    (error) => error instanceof Microsoft365ConnectionConflictError
      && error.code === 'MICROSOFT365_CONSENT_UNAVAILABLE',
  );
  assert.equal(replay.capture.audit.at(-1).outcome, 'failure');
  assert.deepEqual(replay.capture.audit.at(-1).metadata, {
    operation: 'admin_consent_callback_rejected',
    reasonCode: 'consent_unavailable',
  });
  const replayAuditJson = JSON.stringify(replay.capture.audit.at(-1));
  assert.equal(replayAuditJson.includes(STATE), false);
  assert.equal(replayAuditJson.includes(PROVIDER_TENANT_ID), false);
});

test('consent denial during reconnect preserves the last verified healthy connection', async () => {
  const { service, capture } = createHarness({ connection: storedConnection() });
  const connection = await service.completeConsent({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
    state: STATE,
    providerTenantReference: null,
    approved: false,
  });

  assert.equal(capture.providerVerifications.length, 0);
  assert.equal(capture.finalizes[0].status, 'connected');
  assert.equal(capture.finalizes[0].placesPermission, 'granted');
  assert.equal(capture.finalizes[0].calendarsPermission, 'granted');
  assert.equal(capture.finalizes[0].reason, null);
  assert.equal(connection.status, 'connected');
  assert.equal(connection.lastVerifiedAt, '2026-08-25T06:00:00.000Z');
  assert.equal(capture.finalizes[0].auditEvents[0].outcome, 'failure');
  assert.equal(capture.finalizes[0].auditEvents[0].metadata.reasonCode, 'consent_denied');
});

test('binding loss after Graph verification fails finalization for consent and manual verify', async () => {
  const consent = createHarness({ finalizeResult: { status: 'binding_unavailable' } });
  await assert.rejects(
    consent.service.completeConsent({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
      state: STATE,
      providerTenantReference: PROVIDER_TENANT_ID,
      approved: true,
    }),
    (error) => error instanceof Microsoft365ConnectionConflictError
      && error.code === 'MICROSOFT365_PROVIDER_TENANT_MISMATCH',
  );
  assert.equal(consent.capture.finalizes[0].providerTenantReference, PROVIDER_TENANT_ID);
  assert.equal(
    consent.capture.finalizes[0].bindingUnavailableAuditEvent.metadata.reasonCode,
    'provider_binding_changed',
  );

  const verify = createHarness({
    connection: storedConnection(),
    finalizeResult: { status: 'binding_unavailable' },
  });
  await assert.rejects(
    verify.service.verifyConnection({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof Microsoft365ConnectionConflictError
      && error.code === 'MICROSOFT365_PROVIDER_TENANT_MISMATCH',
  );
  assert.equal(verify.capture.finalizes[0].providerTenantReference, PROVIDER_TENANT_ID);
  assert.equal(verify.capture.finalizes[0].bindingUnavailableAuditEvent.outcome, 'failure');
  assert.equal(
    verify.capture.finalizes[0].bindingUnavailableAuditEvent.metadata.reasonCode,
    'provider_binding_changed',
  );
});

test('consent denial may omit the provider tenant and never calls Graph verification', async () => {
  const { service, capture } = createHarness();
  const connection = await service.completeConsent({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
    state: STATE,
    providerTenantReference: null,
    approved: false,
  });

  assert.equal(capture.providerVerifications.length, 0);
  assert.equal(capture.finalizes[0].status, 'disconnected');
  assert.equal(capture.finalizes[0].lastVerifiedAt, null);
  assert.equal(capture.finalizes[0].auditEvents[0].outcome, 'failure');
  assert.equal(connection.status, 'disconnected');
  assert.equal(connection.placesPermission, 'unknown');
  assert.equal(connection.calendarsPermission, 'unknown');
});

test('manual verification persists degraded state and disconnect clears stale permission evidence', async () => {
  const { service, capture } = createHarness({
    connection: storedConnection(),
    verification: {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'granted',
      calendars: 'missing',
      reason: 'calendars_permission_missing',
    },
  });
  const degraded = await service.verifyConnection({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.calendarsPermission, 'missing');
  assert.equal(capture.finalizes[0].auditEvents[0].action, 'integration.verified');

  const disconnected = await service.disconnect({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
  });
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.lastVerifiedAt, null);
  assert.equal(disconnected.placesPermission, 'unknown');
  assert.equal(disconnected.calendarsPermission, 'unknown');
  assert.equal(capture.disconnects.length, 1);
  assert.equal(capture.audit.at(-1).action, 'integration.disconnected');
});

test('cross-tenant principal context is denied before provider or persistence access', async () => {
  const { service, capture } = createHarness();
  await assert.rejects(
    service.startConnection({
      principal: principal({ tenantId: OTHER_TENANT_ID }),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(capture.starts.length, 0);
  assert.equal(capture.providerVerifications.length, 0);
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { PlatformOperationDeniedError } from '../src/platform/application/platform-operation-errors.js';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const PUBLIC_ORIGIN = 'https://platform.example';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = '66666666-6666-4666-8666-666666666666';
const ENTRA_TENANT_ID = '77777777-7777-4777-8777-777777777777';
const ENTRA_CLIENT_ID = '88888888-8888-4888-8888-888888888888';
const PLATFORM_TOKEN = 'P'.repeat(43);
const CUSTOMER_TOKEN = 'C'.repeat(43);
const CSRF_TOKEN = 'X'.repeat(43);
const OIDC_BINDING = 'B'.repeat(43);
const OIDC_STATE = 'S'.repeat(43);
const OIDC_NONCE = 'N'.repeat(43);
const OIDC_CHALLENGE = 'K'.repeat(43);
const MFA_CONTEXT = 'cm-platform-mfa';
const STEP_UP_CONTEXT = 'cm-platform-step-up';

function platformPrincipal() {
  const roles = [PLATFORM_ROLE.TENANT_OPERATOR];
  return Object.freeze({
    operatorId: OPERATOR_ID,
    providerIdentity: Object.freeze({
      provider: 'microsoft_entra_platform',
      tenantReference: ENTRA_TENANT_ID,
      subjectReference: OPERATOR_ID,
    }),
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: 1,
    targetScope: Object.freeze({ mode: 'allowlist', securityVersion: 1 }),
    assurance: Object.freeze({
      level: 'step_up',
      authenticationContext: STEP_UP_CONTEXT,
      authenticatedAt: '2026-08-28T11:59:00.000Z',
    }),
    session: Object.freeze({
      id: SESSION_ID,
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z',
      securityVersion: 1,
      securityEpoch: 7,
      stepUpExpiresAt: '2026-08-28T12:04:00.000Z',
    }),
  });
}

function config(overrides = {}) {
  return {
    mode: 'test',
    serviceVersion: '0.1.0',
    buildId: 'test-build',
    publicOrigin: PUBLIC_ORIGIN,
    entraAuthority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`,
    entraClientId: ENTRA_CLIENT_ID,
    entraRedirectUri: `${PUBLIC_ORIGIN}/api/v1/platform/auth/microsoft/callback`,
    mfaAuthenticationContext: MFA_CONTEXT,
    stepUpAuthenticationContext: STEP_UP_CONTEXT,
    authenticationMaxAgeSeconds: 900,
    maxBodyBytes: 4_096,
    maxResponseBytes: 65_536,
    rateLimitMax: 100,
    rateLimitWindowMs: 60_000,
    rateLimitMaxKeys: 100,
    requestTimeoutMs: 5_000,
    headersTimeoutMs: 5_000,
    keepAliveTimeoutMs: 1_000,
    ...overrides,
  };
}

function authorizationUrl(purpose = 'login') {
  const authenticationContext = purpose === 'step_up' ? STEP_UP_CONTEXT : MFA_CONTEXT;
  const maxAge = purpose === 'step_up' ? 0 : config().authenticationMaxAgeSeconds;
  const url = new URL(`${config().entraAuthority}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', ENTRA_CLIENT_ID);
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('redirect_uri', config().entraRedirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('state', OIDC_STATE);
  url.searchParams.set('nonce', OIDC_NONCE);
  url.searchParams.set('code_challenge', OIDC_CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('max_age', String(maxAge));
  url.searchParams.set('claims', JSON.stringify({
    id_token: { acrs: { essential: true, values: [authenticationContext] } },
  }));
  return url.toString();
}

function services(overrides = {}) {
  const calls = [];
  const auditEvents = [];
  const principal = platformPrincipal();
  const platformSessionService = {
    async resolvePrincipal(request) {
      calls.push(['resolvePrincipal']);
      return request.headers.cookie === `cm_platform_session=${PLATFORM_TOKEN}` ? principal : null;
    },
    async verifyCsrf(request, resolved) {
      calls.push(['verifyCsrf', resolved.operatorId]);
      return request.headers['x-csrf-token'] === CSRF_TOKEN;
    },
    csrfTokenForPrincipal() { return CSRF_TOKEN; },
    async revoke(resolved, input) {
      calls.push(['revokeSession', resolved.operatorId, input]);
      return true;
    },
    clearCookie() {
      return 'cm_platform_session=; Path=/api/v1/platform; HttpOnly; SameSite=Strict; Secure; Max-Age=0';
    },
  };
  const platformAuditService = {
    createUnmappedAuthenticationFailure(value) { return { type: 'unmapped', ...value }; },
    createDeniedEvent(value) { return { type: 'denied', ...value }; },
    async record(value) { auditEvents.push(value); },
    async list(input) {
      calls.push(['listAuditEvents', input]);
      return [];
    },
    async export(input) {
      calls.push(['exportAuditEvents', input]);
      return [];
    },
  };
  const platformAuthService = {
    async start(input) {
      calls.push(['startAuthentication', input]);
      return {
        authorizationUrl: authorizationUrl(input.purpose),
        setCookie: [
          `cm_platform_oidc_tx=${OIDC_BINDING}`,
          'Path=/api/v1/platform/auth/microsoft/callback',
          'HttpOnly',
          'SameSite=Lax',
          'Secure',
          'Max-Age=600',
        ].join('; '),
      };
    },
    async complete(input) {
      calls.push(['completeAuthentication', input]);
      return {
        status: 'authenticated',
        principal,
        csrfToken: CSRF_TOKEN,
        setCookie: [
          `cm_platform_session=${PLATFORM_TOKEN}`,
          'Path=/api/v1/platform',
          'HttpOnly',
          'SameSite=Strict',
          'Secure',
          'Max-Age=3600',
        ].join('; '),
      };
    },
    clearCookie() {
      return [
        'cm_platform_oidc_tx=',
        'Path=/api/v1/platform/auth/microsoft/callback',
        'HttpOnly',
        'SameSite=Lax',
        'Secure',
        'Max-Age=0',
      ].join('; ');
    },
  };
  const platformTenantOperationsService = {
    async listDirectory(input) {
      calls.push(['listDirectory', input]);
      return {
        schemaVersion: 1,
        snapshotAt: '2026-08-28T12:00:00.000Z',
        items: [{
          tenantId: TENANT_ID,
          displayName: 'Example Tenant',
          lifecycle: { status: 'pending', revision: 1 },
          onboardingState: 'invited',
          identityState: 'unbound',
          invitation: {
            id: INVITATION_ID,
            state: 'open',
            revision: 1,
            expiresAt: '2026-08-29T12:00:00.000Z',
          },
          updatedAt: '2026-08-28T12:00:00.000Z',
        }],
        nextCursor: null,
      };
    },
    async createTenantInvitation(input) {
      calls.push(['createTenantInvitation', input]);
      return {
        schemaVersion: 1,
        outcome: 'updated',
        tenant: {
          tenantId: TENANT_ID,
          displayName: input.displayName,
          status: 'pending',
          revision: 1,
          createdAt: '2026-08-28T12:00:00.000Z',
        },
        invitation: {
          invitationId: INVITATION_ID,
          state: 'open',
          revision: 1,
          expiresAt: '2026-08-29T12:00:00.000Z',
        },
        oneTimeDelivery: {
          available: true,
          token: 'I'.repeat(43),
          expiresAt: '2026-08-29T12:00:00.000Z',
        },
      };
    },
    async revokeInvitation(input) {
      calls.push(['revokeInvitation', input]);
      return {
        schemaVersion: 1,
        outcome: 'updated',
        invitation: {
          invitationId: input.invitationId,
          state: 'revoked',
          revision: 2,
          expiresAt: '2026-08-29T12:00:00.000Z',
        },
      };
    },
    async reissueInvitation(input) {
      calls.push(['reissueInvitation', input]);
      return {
        schemaVersion: 1,
        outcome: 'updated',
        invitation: {
          invitationId: input.invitationId,
          state: 'open',
          revision: 2,
          expiresAt: '2026-08-29T12:00:00.000Z',
        },
        oneTimeDelivery: {
          available: true,
          token: 'R'.repeat(43),
          expiresAt: '2026-08-29T12:00:00.000Z',
        },
      };
    },
    async transitionLifecycle(input) {
      calls.push(['transitionLifecycle', input]);
      return {
        schemaVersion: 1,
        outcome: 'updated',
        lifecycle: {
          tenantId: input.tenantId,
          status: input.targetStatus,
          revision: input.expectedRevision + 1,
          changedAt: '2026-08-28T12:00:00.000Z',
        },
      };
    },
  };
  const platformFleetReadinessService = {
    async listFleetReadiness(input) {
      calls.push(['listFleetReadiness', input]);
      return { schemaVersion: 1, snapshotAt: '2026-08-28T12:00:00.000Z', items: [], nextCursor: null };
    },
  };
  const platformHealthMonitor = {
    async evaluate() {
      calls.push(['evaluatePlatformHealth']);
      return { status: 'ready', ready: true, degraded: false };
    },
  };
  const platformEntitlementOperationsService = {
    async listCapabilities(input) {
      calls.push(['listCapabilities', input]);
      return { schemaVersion: 1, items: [] };
    },
    async listPackages(input) {
      calls.push(['listPackages', input]);
      return { schemaVersion: 1, snapshotAt: '2026-08-28T12:00:00.000Z', items: [], nextCursor: null };
    },
    async getTenantEntitlements(input) {
      calls.push(['getTenantEntitlements', input]);
      return { schemaVersion: 1, entitlements: { tenantId: input.tenantId, revision: 1, entries: [] } };
    },
    async previewEntitlementChanges(input) {
      calls.push(['previewEntitlementChanges', input]);
      return { schemaVersion: 1, source: 'direct', plan: { tenantId: input.tenantId, changed: true } };
    },
    async previewPackage(input) {
      calls.push(['previewPackage', input]);
      return { schemaVersion: 1, source: 'package', package: { packageId: input.packageId } };
    },
    async applyEntitlementChanges(input) {
      calls.push(['applyEntitlementChanges', input]);
      return { schemaVersion: 1, outcome: 'updated' };
    },
    async applyPackage(input) {
      calls.push(['applyPackage', input]);
      return { schemaVersion: 1, outcome: 'updated' };
    },
  };
  const platformMicrosoftFleetHealthService = {
    async listFleetHealth(input) {
      calls.push(['listFleetHealth', input]);
      return { schemaVersion: 1, snapshotAt: '2026-08-28T12:00:00.000Z', items: [], nextCursor: null };
    },
  };
  const platformDiagnosticOperationsService = {
    async getTenantSummary(input) {
      calls.push(['getTenantSummary', input]);
      return { schemaVersion: 1, summary: { tenantId: input.tenantId } };
    },
    async lookupCorrelation(input) {
      calls.push(['lookupCorrelation', input]);
      return { schemaVersion: 1, tenantId: input.tenantId, items: [] };
    },
  };
  const platformRecoveryOperationsService = Object.freeze({
    async listRecoveryTargets(input) {
      calls.push(['listRecoveryTargets', input]);
      return {
        schemaVersion: 1,
        tenantId: input.tenantId,
        operation: input.operation,
        snapshotAt: '2026-08-28T12:00:00.000Z',
        items: [],
        nextCursor: null,
      };
    },
    async previewLastTenantAdmin(input) { calls.push(['previewLastTenantAdmin', input]); return { schemaVersion: 1 }; },
    async recoverLastTenantAdmin(input) { calls.push(['recoverLastTenantAdmin', input]); return { schemaVersion: 1 }; },
    async previewMicrosoftReconsent(input) { calls.push(['previewMicrosoftReconsent', input]); return { schemaVersion: 1 }; },
    async initiateMicrosoftReconsent(input) { calls.push(['initiateMicrosoftReconsent', input]); return { schemaVersion: 1 }; },
    async previewRoomMappingRepair(input) { calls.push(['previewRoomMappingRepair', input]); return { schemaVersion: 1 }; },
    async repairRoomMapping(input) { calls.push(['repairRoomMapping', input]); return { schemaVersion: 1 }; },
    async previewIdentityUnbind(input) { calls.push(['previewIdentityUnbind', input]); return { schemaVersion: 1 }; },
    async unbindTenantIdentity(input) { calls.push(['unbindTenantIdentity', input]); return { schemaVersion: 1 }; },
    async previewTenantSessionRevocation(input) { calls.push(['previewTenantSessionRevocation', input]); return { schemaVersion: 1 }; },
    async revokeTenantSessions(input) { calls.push(['revokeTenantSessions', input]); return { schemaVersion: 1 }; },
    async previewUserSessionRevocation(input) { calls.push(['previewUserSessionRevocation', input]); return { schemaVersion: 1 }; },
    async revokeUserSessions(input) { calls.push(['revokeUserSessions', input]); return { schemaVersion: 1 }; },
    async previewTenantSuspension(input) { calls.push(['previewTenantSuspension', input]); return { schemaVersion: 1 }; },
    async suspendTenant(input) { calls.push(['suspendTenant', input]); return { schemaVersion: 1 }; },
    async previewTenantReactivation(input) { calls.push(['previewTenantReactivation', input]); return { schemaVersion: 1 }; },
    async reactivateTenant(input) { calls.push(['reactivateTenant', input]); return { schemaVersion: 1 }; },
  });
  const platformMeteringService = {
    async getUsagePeriod(input) {
      calls.push(['getUsagePeriod', input]);
      return { schemaVersion: 1, tenantId: input.tenantId, period: { start: input.periodStart } };
    },
    async setOperationalQuota(input) {
      calls.push(['setOperationalQuota', input]);
      return { schemaVersion: 1, status: 'updated', tenantId: input.tenantId };
    },
  };
  const platformRuntimeStatusService = {
    async listApprovedDeployments(input) {
      calls.push(['listApprovedDeployments', input]);
      return { schemaVersion: 1, deployments: [] };
    },
    async getServingDeploymentForTenant(input) {
      calls.push(['getServingDeploymentForTenant', input]);
      return { schemaVersion: 1, tenantId: input.tenantId, correlationState: 'unknown', runtime: null };
    },
  };
  return {
    calls,
    auditEvents,
    platformSessionService,
    platformAuditService,
    platformAuthService,
    platformDiagnosticOperationsService,
    platformEntitlementOperationsService,
    platformFleetReadinessService,
    platformHealthMonitor,
    platformMeteringService,
    platformMicrosoftFleetHealthService,
    platformRecoveryOperationsService,
    platformRuntimeStatusService,
    platformTenantOperationsService,
    ...overrides,
  };
}

function request(server, {
  path,
  method = 'GET',
  origin,
  cookie,
  csrfToken,
  idempotencyKey,
  body,
  headers = {},
} = {}) {
  const address = server.address();
  const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const requestHeaders = { Host: 'platform.example', ...headers };
  const unsafe = method === 'POST' || method === 'DELETE';
  if (origin !== null && (origin !== undefined || unsafe)) {
    requestHeaders.Origin = origin || PUBLIC_ORIGIN;
  }
  if (cookie) requestHeaders.Cookie = cookie;
  if (csrfToken) requestHeaders['X-CSRF-Token'] = csrfToken;
  if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;
  if (payload !== null) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: requestHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          rawBody,
          body: rawBody ? JSON.parse(rawBody) : null,
        });
      });
    });
    outgoing.on('error', reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

async function harness(t, overrides = {}, configOverrides = {}) {
  const dependencies = services(overrides);
  const server = createPlatformHttpServer({
    config: config(configOverrides),
    ...dependencies,
    logger: {
      requestCompleted() {},
      securityOutcome() {},
      unhandledError() {},
    },
    metrics: { recordApiRequest() {} },
    requestIdFactory: () => REQUEST_ID,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, ...dependencies };
}

function authenticatedHeaders() {
  return {
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    csrfToken: CSRF_TOKEN,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
}

test('Platform session projection is minimal and customer cookies fail with bounded audit evidence', async (t) => {
  const runtime = await harness(t);
  const customer = await request(runtime.server, {
    path: '/api/v1/platform/session',
    cookie: `cm_session=${CUSTOMER_TOKEN}`,
  });
  assert.equal(customer.statusCode, 401);
  assert.deepEqual(customer.body, {
    error: { code: 'PLATFORM_UNAUTHENTICATED', requestId: REQUEST_ID },
  });
  assert.deepEqual(runtime.auditEvents[0], {
    type: 'unmapped',
    correlationId: REQUEST_ID,
    reasonCode: 'customer_session_rejected',
  });

  const response = await request(runtime.server, {
    path: '/api/v1/platform/session',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    operatorId: OPERATOR_ID,
    roles: [PLATFORM_ROLE.TENANT_OPERATOR],
    permissions: permissionsForPlatformRoles([PLATFORM_ROLE.TENANT_OPERATOR]),
    assurance: { level: 'step_up', authenticatedAt: '2026-08-28T11:59:00.000Z' },
    expiresAt: '2026-08-28T16:00:00.000Z',
    stepUpExpiresAt: '2026-08-28T12:04:00.000Z',
    csrfToken: CSRF_TOKEN,
  });
  assert.equal(response.headers['x-request-id'], REQUEST_ID);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.doesNotMatch(response.rawBody, /providerIdentity|subjectReference|authenticationContext|sessionId|displayName/);

  const customerPath = await request(runtime.server, {
    path: '/api/v1/session',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(customerPath.statusCode, 404);
  assert.equal(customerPath.body.error.code, 'PLATFORM_NOT_FOUND');
});

test('logout requires exact Origin and CSRF, audits denials, and always clears the Platform cookie', async (t) => {
  const runtime = await harness(t);
  const missingOrigin = await request(runtime.server, {
    path: '/api/v1/platform/session',
    method: 'DELETE',
    origin: null,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    csrfToken: CSRF_TOKEN,
  });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(runtime.auditEvents.at(-1).targetId, 'origin');
  assert.deepEqual(runtime.auditEvents.at(-1).metadata, { reasonCode: 'origin_invalid' });

  const missingCsrf = await request(runtime.server, {
    path: '/api/v1/platform/session',
    method: 'DELETE',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(runtime.auditEvents.at(-1).targetId, 'csrf');
  assert.deepEqual(runtime.auditEvents.at(-1).metadata, { reasonCode: 'csrf_invalid' });
  assert.equal(runtime.calls.some(([name]) => name === 'revokeSession'), false);

  const success = await request(runtime.server, {
    path: '/api/v1/platform/session',
    method: 'DELETE',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    csrfToken: CSRF_TOKEN,
  });
  assert.equal(success.statusCode, 204);
  assert.match(success.headers['set-cookie'][0], /^cm_platform_session=;/);
  assert.match(success.headers['set-cookie'][0], /Path=\/api\/v1\/platform/);
  assert.doesNotMatch(success.headers['set-cookie'][0], /Domain=/);
  const revoke = runtime.calls.find(([name]) => name === 'revokeSession');
  assert.deepEqual(revoke[2], { correlationId: REQUEST_ID });
});

test('login and step-up use fixed redirects while step-up requires the existing Platform principal', async (t) => {
  const runtime = await harness(t);
  const login = await request(runtime.server, {
    path: '/api/v1/platform/auth/microsoft/login',
  });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, authorizationUrl());
  assert.match(login.headers['set-cookie'][0], /^cm_platform_oidc_tx=/);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'startAuthentication')[1], {
    purpose: 'login',
    correlationId: REQUEST_ID,
  });

  const customer = await request(runtime.server, {
    path: '/api/v1/platform/auth/microsoft/step-up',
    cookie: `cm_session=${CUSTOMER_TOKEN}`,
  });
  assert.equal(customer.statusCode, 401);

  const hostileOrigin = await request(runtime.server, {
    path: '/api/v1/platform/auth/microsoft/step-up',
    origin: 'https://attacker.example',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(hostileOrigin.statusCode, 403);

  const stepUp = await request(runtime.server, {
    path: '/api/v1/platform/auth/microsoft/step-up',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(stepUp.statusCode, 303);
  assert.equal(stepUp.headers.location, authorizationUrl('step_up'));
  assert.equal(new URL(stepUp.headers.location).searchParams.get('max_age'), '0');
  const calls = runtime.calls.filter(([name]) => name === 'startAuthentication');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].purpose, 'step_up');
  assert.equal(calls[1][1].principal.operatorId, OPERATOR_ID);
  assert.equal(calls[1][1].correlationId, REQUEST_ID);
  assert.deepEqual(Object.keys(calls[1][1]).sort(), ['correlationId', 'principal', 'purpose']);
});

test('callback has an exact positive query and browser-binding contract with fixed result redirect', async (t) => {
  const runtime = await harness(t);
  const malformed = await request(runtime.server, {
    path: `/api/v1/platform/auth/microsoft/callback?state=${OIDC_STATE}&code=valid&tenantId=${TENANT_ID}`,
    cookie: `cm_platform_oidc_tx=${OIDC_BINDING}`,
  });
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.headers['set-cookie'][0], /^cm_platform_oidc_tx=;/);
  assert.equal(runtime.calls.some(([name]) => name === 'completeAuthentication'), false);

  const completed = await request(runtime.server, {
    path: `/api/v1/platform/auth/microsoft/callback?state=${OIDC_STATE}&code=valid-code`,
    cookie: `cm_platform_oidc_tx=${OIDC_BINDING}`,
  });
  assert.equal(completed.statusCode, 303);
  assert.equal(completed.headers.location, `${PUBLIC_ORIGIN}/`);
  assert.equal(completed.headers['set-cookie'].length, 2);
  const completion = runtime.calls.find(([name]) => name === 'completeAuthentication')[1];
  assert.equal(completion.browserBinding, OIDC_BINDING);
  assert.equal(completion.correlationId, REQUEST_ID);
  assert.equal(completion.request.headers.cookie, `cm_platform_oidc_tx=${OIDC_BINDING}`);
  assert.deepEqual(
    { state: completion.state, code: completion.code, providerError: completion.providerError },
    { state: OIDC_STATE, code: 'valid-code', providerError: null },
  );
});

test('tenant routes inject trusted authority and correlation into strict service contracts', async (t) => {
  const runtime = await harness(t);
  const directory = await request(runtime.server, {
    path: '/api/v1/platform/tenants?limit=25&lifecycleStatus=pending&search=Example',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(directory.statusCode, 200);
  assert.equal(directory.body.items[0].invitation.id, INVITATION_ID);
  assert.equal(directory.body.items[0].invitation.revision, 1);
  assert.equal(Object.hasOwn(directory.body, 'requestId'), false);
  const list = runtime.calls.find(([name]) => name === 'listDirectory')[1];
  assert.equal(list.operatorContext.operatorId, OPERATOR_ID);
  assert.deepEqual(list.query, { limit: 25, lifecycleStatus: 'pending', search: 'Example' });

  const creationBody = {
    displayName: 'New Tenant',
    reason: 'Approved customer onboarding',
    confirmation: {
      action: 'tenant.invitation.create',
      displayName: 'New Tenant',
    },
  };
  const creation = await request(runtime.server, {
    path: '/api/v1/platform/tenants',
    method: 'POST',
    body: creationBody,
    ...authenticatedHeaders(),
  });
  assert.equal(creation.statusCode, 201);
  assert.equal(creation.body.oneTimeDelivery.token, 'I'.repeat(43));
  const createCall = runtime.calls.find(([name]) => name === 'createTenantInvitation')[1];
  assert.equal(createCall.operatorContext.operatorId, OPERATOR_ID);
  assert.equal(createCall.correlationId, REQUEST_ID);
  assert.equal(createCall.idempotencyKey, IDEMPOTENCY_KEY);
  assert.deepEqual(createCall.confirmation, creationBody.confirmation);
  assert.equal(Object.hasOwn(createCall, 'tenantId'), false);

  const lifecycleBody = {
    targetStatus: 'active',
    expectedRevision: 2,
    reason: 'Readiness evidence approved',
    confirmation: { action: 'tenant.lifecycle.transition', tenantId: TENANT_ID },
  };
  const lifecycle = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/lifecycle/transitions`,
    method: 'POST',
    body: lifecycleBody,
    ...authenticatedHeaders(),
  });
  assert.equal(lifecycle.statusCode, 200);
  const transition = runtime.calls.find(([name]) => name === 'transitionLifecycle')[1];
  assert.equal(transition.tenantId, TENANT_ID);
  assert.equal(transition.operatorContext.operatorId, OPERATOR_ID);
  assert.equal(transition.correlationId, REQUEST_ID);
  assert.equal(Object.hasOwn(transition, 'requestId'), false);
});

test('tenant transport rejects unsupported methods, malformed IDs, duplicate queries, and missing mutation guards', async (t) => {
  const runtime = await harness(t);
  const unsupported = await request(runtime.server, {
    path: '/api/v1/platform/tenants',
    method: 'DELETE',
    ...authenticatedHeaders(),
  });
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.body.error.code, 'PLATFORM_METHOD_NOT_ALLOWED');

  const malformed = await request(runtime.server, {
    path: '/api/v1/platform/tenants/not-a-uuid/lifecycle/transitions',
    method: 'POST',
    body: {},
    ...authenticatedHeaders(),
  });
  assert.equal(malformed.statusCode, 404);

  const duplicate = await request(runtime.server, {
    path: '/api/v1/platform/tenants?limit=25&limit=50',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(duplicate.statusCode, 400);

  const mutationBody = {
    expectedRevision: 1,
    reason: 'Security-approved revocation',
    confirmation: { action: 'tenant.invitation.revoke', tenantId: TENANT_ID },
  };
  const missingCsrf = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/invitations/${INVITATION_ID}`,
    method: 'DELETE',
    body: mutationBody,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(missingCsrf.statusCode, 403);

  const missingIdempotency = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/invitations/${INVITATION_ID}`,
    method: 'DELETE',
    body: mutationBody,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    csrfToken: CSRF_TOKEN,
  });
  assert.equal(missingIdempotency.statusCode, 400);
  assert.equal(missingIdempotency.body.error.code, 'PLATFORM_IDEMPOTENCY_KEY_INVALID');
  assert.equal(runtime.calls.some(([name]) => name === 'revokeInvitation'), false);
});

test('service denials and unknown failures are centrally mapped without leaking internals or target existence', async (t) => {
  const denied = await harness(t, {
    platformTenantOperationsService: {
      ...services().platformTenantOperationsService,
      async transitionLifecycle() {
        throw new PlatformOperationDeniedError('PLATFORM_TENANT_TARGET_DENIED');
      },
    },
  });
  const body = {
    targetStatus: 'active',
    expectedRevision: 2,
    reason: 'Attempt outside assigned scope',
    confirmation: { action: 'tenant.lifecycle.transition', tenantId: TENANT_ID },
  };
  const response = await request(denied.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/lifecycle/transitions`,
    method: 'POST',
    body,
    ...authenticatedHeaders(),
  });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    error: { code: 'PLATFORM_TENANT_TARGET_DENIED', requestId: REQUEST_ID },
  });
  assert.doesNotMatch(response.rawBody, new RegExp(TENANT_ID));

  const internal = await harness(t, {
    platformTenantOperationsService: {
      ...services().platformTenantOperationsService,
      async listDirectory() {
        throw new Error('database password and SQL detail must stay private');
      },
    },
  });
  const failure = await request(internal.server, {
    path: '/api/v1/platform/tenants',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(failure.statusCode, 500);
  assert.deepEqual(failure.body, {
    error: { code: 'PLATFORM_INTERNAL_ERROR', requestId: REQUEST_ID },
  });
  assert.doesNotMatch(failure.rawBody, /password|SQL|database/i);
});

test('provider redirect output with altered callback authority fails closed', async (t) => {
  const invalid = authorizationUrl().replace(
    encodeURIComponent(config().entraRedirectUri),
    encodeURIComponent('https://attacker.example/callback'),
  );
  const runtime = await harness(t, {
    platformAuthService: {
      ...services().platformAuthService,
      async start() {
        return {
          authorizationUrl: invalid,
          setCookie: [
            `cm_platform_oidc_tx=${OIDC_BINDING}`,
            'Path=/api/v1/platform/auth/microsoft/callback',
            'HttpOnly',
            'SameSite=Lax',
            'Secure',
          ].join('; '),
        };
      },
    },
  });
  const response = await request(runtime.server, {
    path: '/api/v1/platform/auth/microsoft/login',
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, 'PLATFORM_AUTHORIZATION_REDIRECT_INVALID');
  assert.doesNotMatch(response.rawBody, /attacker/);
});

test('provider redirect output enforces the shared max-age, assurance, and telemetry contract', async (t) => {
  const mutations = [
    (url) => url.searchParams.set('max_age', '0'),
    (url) => url.searchParams.set('claims', JSON.stringify({
      id_token: { acrs: { essential: true, values: [STEP_UP_CONTEXT] } },
    })),
    (url) => url.searchParams.set('clidata', '1'),
    (url) => url.searchParams.set('return-client-request-id', 'true'),
    (url) => url.searchParams.set('x-client-SKU', 'unreviewed-sdk'),
  ];
  for (const mutate of mutations) {
    const invalid = new URL(authorizationUrl());
    mutate(invalid);
    const runtime = await harness(t, {
      platformAuthService: {
        ...services().platformAuthService,
        async start() {
          return {
            authorizationUrl: invalid.toString(),
            setCookie: [
              `cm_platform_oidc_tx=${OIDC_BINDING}`,
              'Path=/api/v1/platform/auth/microsoft/callback',
              'HttpOnly',
              'SameSite=Lax',
              'Secure',
            ].join('; '),
          };
        },
      },
    });
    const response = await request(runtime.server, {
      path: '/api/v1/platform/auth/microsoft/login',
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error.code, 'PLATFORM_AUTHORIZATION_REDIRECT_INVALID');
  }
});

test('fleet readiness and Microsoft health expose bounded fixed read routes', async (t) => {
  const runtime = await harness(t);
  const readiness = await request(runtime.server, {
    path: '/api/v1/platform/readiness'
      + '?limit=25&lifecycleStatus=active&readinessState=blocked&blockerCode=identity.missing',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'listFleetReadiness')[1].query, {
    limit: 25,
    lifecycleStatus: 'active',
    readinessState: 'blocked',
    blockerCode: 'identity.missing',
  });

  const health = await request(runtime.server, {
    path: '/api/v1/platform/microsoft365/health?capability=microsoft.calendar&healthStatus=degraded&incidentScope=tenant',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'listFleetHealth')[1].query, {
    capability: 'microsoft.calendar',
    healthStatus: 'degraded',
    incidentScope: 'tenant',
  });

  const polluted = await request(runtime.server, {
    path: `/api/v1/platform/readiness?tenantId=${TENANT_ID}`,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(polluted.statusCode, 400);
  assert.equal(polluted.body.error.code, 'PLATFORM_VALIDATION_FAILED');
});

test('Platform workload health is separate, minimized, and dependency-aware', async (t) => {
  const runtime = await harness(t);
  const live = await request(runtime.server, { path: '/api/v1/platform/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.body, { status: 'live' });
  assert.equal(runtime.calls.some(([name]) => name === 'evaluatePlatformHealth'), false);

  const status = await request(runtime.server, { path: '/api/v1/platform/health/status' });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.body, {
    status: 'ready',
    serviceVersion: '0.1.0',
    buildId: 'test-build',
    environment: 'test',
  });
  assert.equal(status.headers['access-control-allow-origin'], undefined);

  const notReady = await harness(t, {
    platformHealthMonitor: {
      async evaluate() { return { status: 'not_ready', ready: false, degraded: false }; },
    },
  });
  const readiness = await request(notReady.server, { path: '/api/v1/platform/health/ready' });
  assert.equal(readiness.statusCode, 503);
  assert.deepEqual(readiness.body, { status: 'not_ready' });
  assert.doesNotMatch(readiness.rawBody, /database|host|dependency/i);
});

test('Platform liveness remains available after the application rate-limit bucket is exhausted', async (t) => {
  const runtime = await harness(t, {}, { rateLimitMax: 1 });
  const first = await request(runtime.server, { path: '/api/v1/platform/health/ready' });
  assert.equal(first.statusCode, 200);
  const limited = await request(runtime.server, { path: '/api/v1/platform/health/ready' });
  assert.equal(limited.statusCode, 429);
  const live = await request(runtime.server, { path: '/api/v1/platform/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.body, { status: 'live' });
});

test('entitlement routes separate previews from idempotent audited applications', async (t) => {
  const runtime = await harness(t);
  const preview = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/entitlement-previews`,
    method: 'POST',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    csrfToken: CSRF_TOKEN,
    body: { proposals: [{ capabilityId: 'microsoft.calendar', enabled: true }] },
  });
  assert.equal(preview.statusCode, 200);
  const previewCall = runtime.calls.find(([name]) => name === 'previewEntitlementChanges')[1];
  assert.equal(previewCall.tenantId, TENANT_ID);
  assert.equal(previewCall.operatorContext.operatorId, OPERATOR_ID);
  assert.equal(Object.hasOwn(previewCall, 'idempotencyKey'), false);

  const applicationBody = {
    proposals: [{ capabilityId: 'microsoft.calendar', enabled: true }],
    expectedEntitlementRevision: 3,
    reason: 'Approved capability change',
    confirmation: { action: 'tenant.entitlement.apply', tenantId: TENANT_ID },
  };
  const application = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/entitlement-applications`,
    method: 'POST',
    body: applicationBody,
    ...authenticatedHeaders(),
  });
  assert.equal(application.statusCode, 200);
  const applicationCall = runtime.calls.find(([name]) => name === 'applyEntitlementChanges')[1];
  assert.equal(applicationCall.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(applicationCall.correlationId, REQUEST_ID);
  assert.deepEqual(applicationCall.confirmation, applicationBody.confirmation);

  const packagePreview = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/package-previews/operations.standard`,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(packagePreview.statusCode, 200);
  assert.equal(runtime.calls.find(([name]) => name === 'previewPackage')[1].packageId, 'operations.standard');

  const authorityField = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/entitlement-applications`,
    method: 'POST',
    body: { ...applicationBody, operatorId: OPERATOR_ID },
    ...authenticatedHeaders(),
  });
  assert.equal(authorityField.statusCode, 400);
  assert.equal(authorityField.body.error.code, 'PLATFORM_VALIDATION_FAILED');
});

test('diagnostic and audit reads inject server correlation and reject broad query authority', async (t) => {
  const runtime = await harness(t);
  const summary = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/diagnostics`,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(summary.statusCode, 200);
  const summaryCall = runtime.calls.find(([name]) => name === 'getTenantSummary')[1];
  assert.equal(summaryCall.tenantId, TENANT_ID);
  assert.equal(summaryCall.correlationId, REQUEST_ID);

  const lookup = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/diagnostics/correlations/${REQUEST_ID}`
      + '?from=2026-08-28T11%3A00%3A00.000Z'
      + '&to=2026-08-28T12%3A00%3A00.000Z&limit=25',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(lookup.statusCode, 200);
  const lookupCall = runtime.calls.find(([name]) => name === 'lookupCorrelation')[1];
  assert.equal(lookupCall.lookupCorrelationId, REQUEST_ID);
  assert.equal(lookupCall.limit, 25);

  const audit = await request(runtime.server, {
    path: '/api/v1/platform/audit/events?limit=25&beforeSequence=42',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(audit.statusCode, 200);
  assert.deepEqual(audit.body, { schemaVersion: 1, items: [] });
  const auditCall = runtime.calls.find(([name]) => name === 'listAuditEvents')[1];
  assert.equal(auditCall.correlationId, REQUEST_ID);
  assert.equal(auditCall.beforeSequence, 42);

  const forbiddenQuery = await request(runtime.server, {
    path: `/api/v1/platform/audit/events?tenantId=${TENANT_ID}`,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(forbiddenQuery.statusCode, 400);
});

test('recovery routes expose only fixed preview and execution use cases', async (t) => {
  const runtime = await harness(t);
  const preview = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/recovery/last-tenant-admin/previews`,
    method: 'POST',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
    csrfToken: CSRF_TOKEN,
    body: { targetUserId: OPERATOR_ID },
  });
  assert.equal(preview.statusCode, 200);
  const previewCall = runtime.calls.find(([name]) => name === 'previewLastTenantAdmin')[1];
  assert.equal(previewCall.targetUserId, OPERATOR_ID);
  assert.equal(previewCall.correlationId, REQUEST_ID);
  assert.equal(Object.hasOwn(previewCall, 'idempotencyKey'), false);

  const execution = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/recovery/last-tenant-admin/executions`,
    method: 'POST',
    body: {
      targetUserId: OPERATOR_ID,
      recoveryContextId: INVITATION_ID,
      reason: 'Approved last administrator recovery',
      confirmation: { action: 'tenant.recovery.last_admin', tenantId: TENANT_ID },
    },
    ...authenticatedHeaders(),
  });
  assert.equal(execution.statusCode, 200);
  const executeCall = runtime.calls.find(([name]) => name === 'recoverLastTenantAdmin')[1];
  assert.equal(executeCall.recoveryContextId, INVITATION_ID);
  assert.equal(executeCall.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(executeCall.operatorContext.operatorId, OPERATOR_ID);

  const generic = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/recovery/actions`,
    method: 'POST',
    body: { action: 'identity-unbind' },
    ...authenticatedHeaders(),
  });
  assert.equal(generic.statusCode, 404);
  assert.equal(generic.body.error.code, 'PLATFORM_NOT_FOUND');
});

test('metering, quota, and runtime routes expose only protected minimized projections', async (t) => {
  const runtime = await harness(t);
  const usage = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/metering/usage?periodStart=2026-08-01T00%3A00%3A00.000Z`,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(usage.statusCode, 200);
  assert.equal(runtime.calls.find(([name]) => name === 'getUsagePeriod')[1].periodStart, '2026-08-01T00:00:00.000Z');

  const quota = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/quotas/requests_created`,
    method: 'POST',
    body: {
      state: 'configured',
      softLimit: 500,
      hardLimit: 750,
      expectedRevision: 0,
      reason: 'Approved operational protection',
      confirmation: {
        action: 'tenant.quota.set',
        tenantId: TENANT_ID,
        dimension: 'requests_created',
      },
    },
    ...authenticatedHeaders(),
  });
  assert.equal(quota.statusCode, 200);
  const quotaCall = runtime.calls.find(([name]) => name === 'setOperationalQuota')[1];
  assert.equal(quotaCall.dimension, 'requests_created');
  assert.equal(quotaCall.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(quotaCall.correlationId, REQUEST_ID);

  const deployments = await request(runtime.server, {
    path: '/api/v1/platform/runtime/deployments',
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(deployments.statusCode, 200);
  const serving = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/runtime`,
    cookie: `cm_platform_session=${PLATFORM_TOKEN}`,
  });
  assert.equal(serving.statusCode, 200);
  assert.equal(runtime.calls.find(([name]) => name === 'getServingDeploymentForTenant')[1].tenantId, TENANT_ID);

  const internalCounter = await request(runtime.server, {
    path: `/api/v1/platform/tenants/${TENANT_ID}/metering/events`,
    method: 'POST',
    body: { units: 1000 },
    ...authenticatedHeaders(),
  });
  assert.equal(internalCounter.statusCode, 404);
});

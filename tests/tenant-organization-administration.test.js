import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { createTenantOrganizationService } from '../src/application/tenant-organization-service.js';
import { TenantSettingsConflictError, TenantSettingsInputError } from '../src/application/tenant-settings-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { normalizeTenantOrganization } from '../src/domain/tenant-organization.js';
import {
  TENANT_ORGANIZATION_ROUTES,
  createTenantOrganizationHttpHandler,
  tenantOrganizationRouteModule,
} from '../src/http/settings/organization.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const LOGO_REF = `managed-brand:${'A'.repeat(22)}`;

function organization(overrides = {}) {
  return {
    displayName: 'Example GmbH',
    businessMetadata: {
      legalName: 'Example GmbH',
      registrationNumber: 'HRB 12345',
      countryCode: 'DE',
    },
    presentation: { defaultLocale: 'de-DE', defaultCurrency: 'EUR' },
    branding: { logoAssetRef: null, accentToken: 'default' },
    ...overrides,
  };
}

function adminPrincipal(tenantId = TENANT_A) {
  return {
    userId: ADMIN_ID,
    tenantId,
    roles: ['tenant_admin'],
    permissions: ['tenant:configure'],
  };
}

function employeePrincipal() {
  return {
    userId: ADMIN_ID,
    tenantId: TENANT_A,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };
}

function repository(initial = organization()) {
  let current = { revision: 1, organization: normalizeTenantOrganization(initial) };
  const snapshots = [{ revision: 1, effectiveAt: '2026-08-27T10:00:00.000Z', organization: current.organization }];
  return {
    get current() {
      return current;
    },
    async loadCurrent(tenantId) {
      assert.equal(tenantId, TENANT_A);
      return current;
    },
    async listHistory({ tenantId, limit, beforeRevision }) {
      assert.equal(tenantId, TENANT_A);
      return snapshots
        .filter((entry) => beforeRevision === null || entry.revision < beforeRevision)
        .slice(-limit)
        .reverse();
    },
    async update(value) {
      assert.equal(value.tenantId, TENANT_A);
      assert.equal(value.actorUserId, ADMIN_ID);
      if (value.expectedRevision !== current.revision) {
        return { status: 'conflict', currentRevision: current.revision };
      }
      const previous = current.organization;
      const nextRevision = current.revision + 1;
      const event = value.auditEventFor({ previous, next: value.organization, nextRevision });
      assert.equal(event.tenantId, TENANT_A);
      assert.equal(event.action, 'tenant.configuration.changed');
      current = { revision: nextRevision, organization: value.organization };
      snapshots.push({
        revision: nextRevision,
        effectiveAt: value.changedAt.toISOString(),
        organization: value.organization,
      });
      return { status: 'updated', current };
    },
  };
}

function serviceFixture() {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const store = repository();
  const authorizedReferences = [];
  const service = createTenantOrganizationService({
    repository: store,
    authorizationPolicy,
    auditService: audit.service,
    managedAssetPolicy: {
      async authorizeTenantReference(value) {
        authorizedReferences.push(value);
        return value.reference === null || (value.tenantId === TENANT_A && value.reference === LOGO_REF);
      },
    },
    clock: () => Date.parse('2026-08-27T11:00:00.000Z'),
  });
  return { service, store, audit, authorizedReferences };
}

test('organization schema rejects unsafe text, arbitrary styling and remote assets', () => {
  assert.throws(
    () => normalizeTenantOrganization(organization({ displayName: '<script>alert(1)</script>' })),
    /TENANT_ORGANIZATION_DISPLAY_NAME_INVALID/,
  );
  assert.throws(
    () => normalizeTenantOrganization(organization({
      branding: { logoAssetRef: 'https://customer.example/logo.svg', accentToken: 'default' },
    })),
    /TENANT_ORGANIZATION_LOGO_REFERENCE_INVALID/,
  );
  assert.throws(
    () => normalizeTenantOrganization(organization({
      branding: { logoAssetRef: null, accentToken: '#ff0000' },
    })),
    /TENANT_ORGANIZATION_ACCENT_INVALID/,
  );
  assert.throws(
    () => normalizeTenantOrganization({ ...organization(), arbitraryCss: 'body{}' }),
    /TENANT_ORGANIZATION_INVALID/,
  );
});

test('Tenant Admin update advances only the expected revision and records bounded audit evidence', async () => {
  const fixture = serviceFixture();
  const principal = adminPrincipal();
  const tenantContext = { tenantId: TENANT_A, status: 'active' };
  const changed = organization({
    displayName: 'Changed GmbH',
    branding: { logoAssetRef: LOGO_REF, accentToken: 'default' },
  });
  const result = await fixture.service.update({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 1,
    organization: changed,
  });
  assert.equal(result.revision, 2);
  assert.equal(result.organization.displayName, 'Changed GmbH');
  assert.deepEqual(fixture.authorizedReferences, [{ tenantId: TENANT_A, reference: LOGO_REF }]);

  await assert.rejects(
    fixture.service.update({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 1,
      organization: changed,
    }),
    (error) => error instanceof TenantSettingsConflictError && error.currentRevision === 2,
  );
  assert.equal(fixture.store.current.revision, 2);
  const history = await fixture.service.history({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    limit: 1,
  });
  assert.equal(history.revisions[0].revision, 2);
  assert.equal(history.nextBeforeRevision, 2);

  await assert.rejects(
    fixture.service.update({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 2,
      expectedRevision: 2,
      organization: changed,
    }),
    (error) => error instanceof TenantSettingsInputError
      && error.code === 'TENANT_SETTINGS_SCHEMA_VERSION_UNSUPPORTED',
  );
});

test('managed references fail closed without same-Tenant asset authority', async () => {
  const fixture = serviceFixture();
  await assert.rejects(
    fixture.service.update({
      principal: adminPrincipal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 1,
      organization: organization({
        branding: { logoAssetRef: `managed-brand:${'B'.repeat(22)}`, accentToken: 'default' },
      }),
    }),
    (error) => error instanceof TenantSettingsInputError
      && error.code === 'TENANT_ORGANIZATION_LOGO_REFERENCE_UNAVAILABLE',
  );
  assert.equal(fixture.store.current.revision, 1);
});

test('authorization denies Employees and mismatched Tenant contexts without repository access', async () => {
  const fixture = serviceFixture();
  await assert.rejects(
    fixture.service.current({
      principal: employeePrincipal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(fixture.audit.events.at(-1).action, 'authorization.denied');

  let called = false;
  const service = createTenantOrganizationService({
    repository: {
      async loadCurrent() { called = true; },
      async listHistory() { called = true; },
      async update() { called = true; },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: fixture.audit.service,
  });
  await assert.rejects(
    service.current({
      principal: adminPrincipal(TENANT_A),
      tenantContext: { tenantId: TENANT_B },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(called, false);
});

function request(method, body = null, csrf = null) {
  const raw = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  const incoming = Readable.from(raw);
  incoming.method = method;
  incoming.headers = body === null ? {} : {
    'content-type': 'application/json',
    'content-length': String(raw[0].length),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
  };
  return incoming;
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
}

test('bounded organization route requires CSRF and rejects browser Tenant selectors', async () => {
  assert.equal(tenantOrganizationRouteModule.id, 'tenant-organization');
  const fixture = serviceFixture();
  const handler = createTenantOrganizationHttpHandler({
    service: fixture.service,
    principalGuard: {
      async require(incoming, { csrf }) {
        if (csrf && incoming.headers['x-csrf-token'] !== 'valid') throw new ApiError(403, 'CSRF_INVALID');
        return adminPrincipal();
      },
    },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_A, status: 'active' }; } },
    maxBodyBytes: 65_536,
    maxResponseBytes: 65_536,
  });
  const body = { schemaVersion: 1, expectedRevision: 1, organization: organization() };
  await assert.rejects(
    handler({
      request: request('PUT', body),
      response: response(),
      parsedUrl: new URL(`http://localhost${TENANT_ORGANIZATION_ROUTES.current}`),
      path: TENANT_ORGANIZATION_ROUTES.current,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'CSRF_INVALID',
  );
  await assert.rejects(
    handler({
      request: request('GET'),
      response: response(),
      parsedUrl: new URL(`http://localhost${TENANT_ORGANIZATION_ROUTES.current}?tenantId=${TENANT_B}`),
      path: TENANT_ORGANIZATION_ROUTES.current,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'VALIDATION_FAILED',
  );

  const successResponse = response();
  assert.equal(await handler({
    request: request('PUT', body, 'valid'),
    response: successResponse,
    parsedUrl: new URL(`http://localhost${TENANT_ORGANIZATION_ROUTES.current}`),
    path: TENANT_ORGANIZATION_ROUTES.current,
    requestId: CORRELATION_ID,
  }), 200);
  assert.equal(successResponse.body.revision, 2);

  await assert.rejects(
    handler({
      request: request('PUT', {
        ...body,
        organization: organization({ displayName: 'A'.repeat(40_000) }),
      }, 'valid'),
      response: response(),
      parsedUrl: new URL(`http://localhost${TENANT_ORGANIZATION_ROUTES.current}`),
      path: TENANT_ORGANIZATION_ROUTES.current,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'BODY_TOO_LARGE',
  );
});

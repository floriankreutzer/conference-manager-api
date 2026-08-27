import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import {
  CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
  DEFAULT_LOGO_PRESET,
  MANAGED_LOGO_PRESET,
  createCodeShippedManagedBrandPolicy,
} from '../src/application/managed-brand-preset-policy.js';
import { createTenantPresentationService } from '../src/application/tenant-presentation-service.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import {
  TENANT_PRESENTATION_PATH,
  createTenantPresentationHttpHandler,
  tenantPresentationRouteModule,
} from '../src/http/settings/tenant-presentation-routes.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const UNKNOWN_REFERENCE = `managed-brand:${'Z'.repeat(22)}`;

function organization(logoAssetRef = CODE_SHIPPED_MANAGED_BRAND_REFERENCE) {
  return {
    displayName: 'Example GmbH',
    businessMetadata: {
      legalName: 'Example Holdings GmbH',
      registrationNumber: 'HRB 12345',
      countryCode: 'DE',
    },
    presentation: { defaultLocale: 'de-DE', defaultCurrency: 'EUR' },
    branding: { logoAssetRef, accentToken: 'default' },
  };
}

const PRINCIPAL_BY_ROLE = Object.freeze({
  employee: Object.freeze({
    roles: Object.freeze(['employee']),
    permissions: Object.freeze(['request:read', 'request:cancel']),
  }),
  conference_manager: Object.freeze({
    roles: Object.freeze(['conference_manager']),
    permissions: Object.freeze(['request:read', 'request:manage']),
  }),
  tenant_admin: Object.freeze({
    roles: Object.freeze(['tenant_admin']),
    permissions: Object.freeze([
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ]),
  }),
});

function principal(role, tenantId = TENANT_A) {
  return { userId: USER_ID, tenantId, ...PRINCIPAL_BY_ROLE[role] };
}

function serviceFixture({ logoAssetRef = CODE_SHIPPED_MANAGED_BRAND_REFERENCE, policy } = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  let repositoryCalls = 0;
  const service = createTenantPresentationService({
    repository: {
      async loadCurrent(tenantId) {
        repositoryCalls += 1;
        assert.equal(tenantId, TENANT_A);
        return { revision: 7, organization: organization(logoAssetRef) };
      },
    },
    authorizationPolicy,
    auditService: audit.service,
    managedBrandPolicy: policy || createCodeShippedManagedBrandPolicy(),
  });
  return {
    service,
    audit,
    repositoryCalls: () => repositoryCalls,
  };
}

test('all recognized Tenant roles receive the same minimized revisioned presentation', async () => {
  const fixture = serviceFixture();
  for (const role of Object.keys(PRINCIPAL_BY_ROLE)) {
    const result = await fixture.service.current({
      principal: principal(role),
      tenantContext: { tenantId: TENANT_A, status: 'active' },
      correlationId: CORRELATION_ID,
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      revision: 7,
      presentation: {
        displayName: 'Example GmbH',
        defaultLocale: 'de-DE',
        defaultCurrency: 'EUR',
        branding: {
          logoPreset: MANAGED_LOGO_PRESET,
          accentToken: 'default',
        },
      },
    });
    const wire = JSON.stringify(result);
    for (const omitted of [
      TENANT_A,
      'Example Holdings GmbH',
      'HRB 12345',
      CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
      'businessMetadata',
      'logoAssetRef',
    ]) {
      assert.equal(wire.includes(omitted), false);
    }
  }
  assert.equal(fixture.repositoryCalls(), 3);
  assert.equal(fixture.audit.events.length, 0);
});

test('code-shipped managed-brand policy allows only its exact preset for a known Tenant', async () => {
  const policy = createCodeShippedManagedBrandPolicy();
  assert.equal(await policy.authorizeTenantReference({
    tenantId: TENANT_A,
    reference: CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
  }), true);
  assert.equal(await policy.authorizeTenantReference({
    tenantId: TENANT_A,
    reference: UNKNOWN_REFERENCE,
  }), false);
  assert.equal(await policy.authorizeTenantReference({
    tenantId: 'tenant-selected-by-browser',
    reference: CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
  }), false);
  assert.deepEqual(await policy.resolveTenantReference({
    tenantId: TENANT_A,
    reference: CODE_SHIPPED_MANAGED_BRAND_REFERENCE,
  }), { logoPreset: MANAGED_LOGO_PRESET });
  assert.equal(await policy.resolveTenantReference({
    tenantId: TENANT_A,
    reference: UNKNOWN_REFERENCE,
  }), null);
});

test('missing, unknown, failed and malformed managed references use the safe product fallback', async () => {
  const cases = [
    serviceFixture({ logoAssetRef: null }),
    serviceFixture({ logoAssetRef: UNKNOWN_REFERENCE }),
    serviceFixture({
      policy: { async resolveTenantReference() { throw new Error('resolver unavailable'); } },
    }),
    serviceFixture({
      policy: { async resolveTenantReference() { return { logoPreset: 'arbitrary-reference' }; } },
    }),
  ];
  for (const fixture of cases) {
    const result = await fixture.service.current({
      principal: principal('employee'),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
    });
    assert.deepEqual(result.presentation.branding, {
      logoPreset: DEFAULT_LOGO_PRESET,
      accentToken: 'default',
    });
    assert.equal(JSON.stringify(result).includes('managed-brand:'), false);
  }
});

test('authorization and Tenant mismatch fail before persistence with bounded audit behavior', async () => {
  const fixture = serviceFixture();
  await assert.rejects(
    fixture.service.current({
      principal: {
        userId: USER_ID,
        tenantId: TENANT_A,
        roles: ['unrecognized'],
        permissions: [],
      },
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(fixture.repositoryCalls(), 0);
  assert.equal(fixture.audit.events.length, 1);
  assert.equal(fixture.audit.events[0].action, 'authorization.denied');
  assert.equal(fixture.audit.events[0].targetType, 'tenant_presentation');
  assert.deepEqual(fixture.audit.events[0].metadata, { operation: 'read' });

  await assert.rejects(
    fixture.service.current({
      principal: principal('employee', TENANT_A),
      tenantContext: { tenantId: TENANT_B },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(fixture.repositoryCalls(), 0);
  assert.equal(fixture.audit.events.length, 1);
});

function request(method = 'GET', body = null) {
  const bytes = body === null ? [] : [Buffer.from(body)];
  const value = Readable.from(bytes);
  value.method = method;
  value.headers = body === null ? {} : {
    'content-type': 'application/json',
    'content-length': String(bytes[0].length),
  };
  return value;
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
}

test('presentation HTTP route requires authentication and rejects client-selected scope or body', async () => {
  assert.equal(tenantPresentationRouteModule.id, 'tenant-presentation');
  let serviceCalls = 0;
  const service = {
    async current() {
      serviceCalls += 1;
      return { schemaVersion: 1, revision: 7, presentation: {} };
    },
  };
  const unauthenticated = createTenantPresentationHttpHandler({
    tenantPresentationService: service,
    principalGuard: {
      async require() { throw new ApiError(401, 'AUTHENTICATION_REQUIRED'); },
    },
    tenantGuard: { async requireKnown() { throw new Error('must not run'); } },
    maxResponseBytes: 16_384,
  });
  await assert.rejects(
    unauthenticated({
      request: request(),
      response: response(),
      parsedUrl: new URL(TENANT_PRESENTATION_PATH, 'https://conference.example'),
      path: TENANT_PRESENTATION_PATH,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.statusCode === 401,
  );
  assert.equal(serviceCalls, 0);

  const authenticated = createTenantPresentationHttpHandler({
    tenantPresentationService: service,
    principalGuard: { async require() { return principal('employee'); } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_A }; } },
    maxResponseBytes: 16_384,
  });
  for (const invalid of [
    {
      request: request(),
      url: `${TENANT_PRESENTATION_PATH}?tenantId=${TENANT_B}`,
    },
    {
      request: request('GET', '{}'),
      url: TENANT_PRESENTATION_PATH,
    },
  ]) {
    await assert.rejects(
      authenticated({
        request: invalid.request,
        response: response(),
        parsedUrl: new URL(invalid.url, 'https://conference.example'),
        path: TENANT_PRESENTATION_PATH,
        requestId: CORRELATION_ID,
      }),
      (error) => error instanceof ApiError && error.statusCode === 400,
    );
  }
  assert.equal(serviceCalls, 0);

  const success = response();
  assert.equal(await authenticated({
    request: request(),
    response: success,
    parsedUrl: new URL(TENANT_PRESENTATION_PATH, 'https://conference.example'),
    path: TENANT_PRESENTATION_PATH,
    requestId: CORRELATION_ID,
  }), 200);
  assert.equal(success.body.revision, 7);
  assert.equal(serviceCalls, 1);
});

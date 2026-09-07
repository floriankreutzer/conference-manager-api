import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { createTenantCatalogueService } from '../src/application/tenant-catalogue-service.js';
import { TenantSettingsConflictError, TenantSettingsInputError } from '../src/application/tenant-settings-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import {
  normalizeTenantCatalogue,
  snapshotTenantCatalogueSelection,
} from '../src/domain/tenant-catalogue.js';
import {
  TENANT_CATALOGUE_ROUTES,
  createTenantCatalogueHttpHandler,
  tenantCatalogueRouteModule,
} from '../src/http/settings/catalogue.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const SITE_ID = 'berlin';
const ROOM_ID = 'berlin-large';

function price(amountMinor = 2500, currency = 'EUR') {
  return { amountMinor, currency };
}

function common(id, name, overrides = {}) {
  return {
    id,
    name,
    description: null,
    price: price(),
    active: true,
    order: 10,
    siteIds: [SITE_ID],
    roomIds: [ROOM_ID],
    ...overrides,
  };
}

function catalogue(overrides = {}) {
  return {
    services: [common('video-support', 'Video support')],
    equipment: [common('projector', 'Projector', { price: price(1000) })],
    cateringItems: [common('coffee', 'Coffee', { price: price(300) })],
    cateringPackages: [{
      ...common('meeting', 'Meeting package', { price: price(1500) }),
      itemIds: ['coffee'],
      variants: [{
        id: 'premium',
        name: 'Premium',
        description: null,
        price: price(2200),
        active: true,
        order: 1,
      }],
    }],
    ...overrides,
  };
}

function principal(tenantId = TENANT_A) {
  return {
    userId: ADMIN_ID,
    tenantId,
    roles: ['conference_manager'],
    permissions: [
      'request:read',
      'request:manage',
      'tenant:rooms:business:manage',
      'tenant:catalogue:manage',
    ],
  };
}

function tenantAdmin(tenantId = TENANT_A) {
  return {
    userId: ADMIN_ID,
    tenantId,
    roles: ['tenant_admin'],
    permissions: [
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
  };
}

function fakeRepository(initial = catalogue()) {
  let current = { revision: 1, catalogue: normalizeTenantCatalogue(initial) };
  const history = [{ revision: 1, effectiveAt: '2026-08-27T10:00:00.000Z', catalogue: current.catalogue }];
  let replacementStatus = null;
  return {
    get current() { return current; },
    set replacementStatus(value) { replacementStatus = value; },
    async loadCurrent(tenantId) {
      assert.equal(tenantId, TENANT_A);
      return current;
    },
    async listHistory({ tenantId, limit, beforeRevision }) {
      assert.equal(tenantId, TENANT_A);
      return history
        .filter((entry) => beforeRevision === null || entry.revision < beforeRevision)
        .slice(-limit)
        .reverse();
    },
    async scopeExists({ tenantId, siteId, roomId }) {
      return tenantId === TENANT_A && siteId === SITE_ID && roomId === ROOM_ID;
    },
    async replace(value) {
      assert.equal(value.tenantId, TENANT_A);
      assert.equal(value.actorUserId, ADMIN_ID);
      if (replacementStatus) return { status: replacementStatus };
      if (value.expectedRevision !== current.revision) {
        return { status: 'conflict', currentRevision: current.revision };
      }
      const nextRevision = current.revision + 1;
      const event = value.auditEventFor({
        previous: current.catalogue,
        next: value.catalogue,
        nextRevision,
      });
      assert.equal(event.action, 'tenant.configuration.changed');
      assert.equal(event.metadata.serviceCount, value.catalogue.services.length);
      current = { revision: nextRevision, catalogue: value.catalogue };
      history.push({
        revision: nextRevision,
        effectiveAt: value.changedAt.toISOString(),
        catalogue: value.catalogue,
      });
      return { status: 'updated', current };
    },
  };
}

function fixture() {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const repository = fakeRepository();
  const service = createTenantCatalogueService({
    repository,
    authorizationPolicy,
    auditService: audit.service,
    clock: () => Date.parse('2026-08-27T11:00:00.000Z'),
  });
  return { service, repository, audit };
}

test('catalogue validation rejects price manipulation, markup, unknown fields and inactive references', () => {
  assert.throws(
    () => normalizeTenantCatalogue(catalogue({
      services: [common('bad', 'Bad', { price: price(-1) })],
    })),
    /MONEY_AMOUNT_INVALID/,
  );
  assert.throws(
    () => normalizeTenantCatalogue(catalogue({
      services: [common('bad', 'Bad', { price: price(1.5) })],
    })),
    /MONEY_AMOUNT_INVALID/,
  );
  assert.throws(
    () => normalizeTenantCatalogue(catalogue({
      services: [common('bad', '<img src=x onerror=alert(1)>')],
    })),
    /TENANT_CATALOGUE_SERVICE_INVALID_NAME/,
  );
  assert.throws(
    () => normalizeTenantCatalogue({ ...catalogue(), providerOrderUrl: 'https://example.invalid' }),
    /TENANT_CATALOGUE_INVALID/,
  );
  assert.throws(
    () => normalizeTenantCatalogue(catalogue({
      cateringItems: [common('coffee', 'Coffee', { active: false })],
    })),
    /TENANT_CATALOGUE_PACKAGE_ITEM_REFERENCE_INVALID/,
  );
});

test('immutable Request snapshot uses authoritative identity, description and price context', () => {
  const snapshot = snapshotTenantCatalogueSelection({
    catalogue: catalogue(),
    revision: 7,
    selection: {
      serviceIds: ['video-support'],
      equipmentIds: ['projector'],
      cateringItemIds: [],
      catering: [{ packageId: 'meeting', variantId: 'premium', itemIds: ['coffee'] }],
    },
    siteId: SITE_ID,
    roomId: ROOM_ID,
    capturedAt: '2026-08-27T12:00:00.000Z',
  });
  assert.equal(snapshot.catalogRevision, 7);
  assert.deepEqual(snapshot.services[0].price, price(2500));
  assert.deepEqual(snapshot.catering[0].variant.price, price(2200));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.catering[0].items[0].price), true);
  assert.throws(() => { snapshot.services[0].name = 'Changed later'; }, TypeError);

  const deactivated = catalogue({
    services: [common('video-support', 'Video support', { active: false })],
  });
  assert.throws(
    () => snapshotTenantCatalogueSelection({
      catalogue: deactivated,
      revision: 8,
      selection: {
        serviceIds: ['video-support'],
        equipmentIds: [],
        cateringItemIds: [],
        catering: [],
      },
      siteId: SITE_ID,
      roomId: ROOM_ID,
      capturedAt: '2026-08-27T13:00:00.000Z',
    }),
    /TENANT_CATALOGUE_SELECTION_UNAVAILABLE/,
  );
  assert.equal(snapshot.services[0].name, 'Video support');
});

test('Conference Manager update is revisioned and stale writes do not replace current state', async () => {
  const setup = fixture();
  const tenantContext = { tenantId: TENANT_A, status: 'active' };
  const proposed = catalogue({ services: [common('video-support', 'Video support changed')] });
  const updated = await setup.service.update({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 1,
    catalogue: proposed,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.catalogue.services[0].name, 'Video support changed');

  await assert.rejects(
    setup.service.update({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 1,
      catalogue: catalogue(),
    }),
    (error) => error instanceof TenantSettingsConflictError && error.currentRevision === 2,
  );
  assert.equal(setup.repository.current.catalogue.services[0].name, 'Video support changed');

  await assert.rejects(
    setup.service.update({
      principal: principal(),
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 2,
      expectedRevision: 2,
      catalogue: proposed,
    }),
    (error) => error instanceof TenantSettingsInputError
      && error.code === 'TENANT_SETTINGS_SCHEMA_VERSION_UNSUPPORTED',
  );
});

test('archive protection and cross-Tenant request scope fail closed', async () => {
  const setup = fixture();
  setup.repository.replacementStatus = 'removal_forbidden';
  await assert.rejects(
    setup.service.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 1,
      catalogue: catalogue(),
    }),
    (error) => error instanceof TenantSettingsInputError
      && error.code === 'TENANT_CATALOGUE_ARCHIVE_REQUIRED',
  );

  await assert.rejects(
    setup.service.snapshotForRequest({
      tenantId: TENANT_B,
      siteId: SITE_ID,
      roomId: ROOM_ID,
      selection: { serviceIds: [], equipmentIds: [], cateringItemIds: [], catering: [] },
    }),
    (error) => error instanceof TenantSettingsInputError
      && error.code === 'TENANT_CATALOGUE_SELECTION_UNAVAILABLE',
  );
});

test('authorization denies Employee, Tenant Admin and mismatched Tenant contexts before persistence', async () => {
  const setup = fixture();
  const employee = {
    userId: ADMIN_ID,
    tenantId: TENANT_A,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };
  await assert.rejects(
    setup.service.current({
      principal: employee,
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(setup.audit.events.at(-1).action, 'authorization.denied');

  await assert.rejects(
    setup.service.current({
      principal: tenantAdmin(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(setup.audit.events.at(-1).action, 'authorization.denied');

  await assert.rejects(
    setup.service.current({
      principal: principal(TENANT_A),
      tenantContext: { tenantId: TENANT_B },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
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

test('bounded catalogue route requires CSRF and accepts no Tenant selector', async () => {
  assert.equal(tenantCatalogueRouteModule.id, 'tenant-catalogue');
  const setup = fixture();
  const handler = createTenantCatalogueHttpHandler({
    service: setup.service,
    principalGuard: {
      async require(incoming, { csrf }) {
        if (csrf && incoming.headers['x-csrf-token'] !== 'valid') throw new ApiError(403, 'CSRF_INVALID');
        return principal();
      },
    },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_A, status: 'active' }; } },
    maxBodyBytes: 300_000,
    maxResponseBytes: 300_000,
  });
  const body = { schemaVersion: 1, expectedRevision: 1, catalogue: catalogue() };
  await assert.rejects(
    handler({
      request: request('PUT', body),
      response: response(),
      parsedUrl: new URL(`http://localhost${TENANT_CATALOGUE_ROUTES.current}`),
      path: TENANT_CATALOGUE_ROUTES.current,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'CSRF_INVALID',
  );
  await assert.rejects(
    handler({
      request: request('GET'),
      response: response(),
      parsedUrl: new URL(`http://localhost${TENANT_CATALOGUE_ROUTES.current}?tenantId=${TENANT_B}`),
      path: TENANT_CATALOGUE_ROUTES.current,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'VALIDATION_FAILED',
  );

  const successResponse = response();
  assert.equal(await handler({
    request: request('PUT', body, 'valid'),
    response: successResponse,
    parsedUrl: new URL(`http://localhost${TENANT_CATALOGUE_ROUTES.current}`),
    path: TENANT_CATALOGUE_ROUTES.current,
    requestId: CORRELATION_ID,
  }), 200);
  assert.equal(successResponse.body.revision, 2);

  await assert.rejects(
    handler({
      request: request('PUT', {
        ...body,
        catalogue: catalogue({
          services: [common('oversized', 'A'.repeat(270_000))],
        }),
      }, 'valid'),
      response: response(),
      parsedUrl: new URL(`http://localhost${TENANT_CATALOGUE_ROUTES.current}`),
      path: TENANT_CATALOGUE_ROUTES.current,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'BODY_TOO_LARGE',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/api-error.js';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import {
  createDemoCustomerControlRoutes,
  DEMO_CUSTOMER_SESSION_PATH,
} from '../src/demo/http/customer-control-routes.js';
import {
  createDemoPlatformControlRoutes,
  DEMO_PLATFORM_SESSION_PATH,
} from '../src/demo/http/platform-control-routes.js';
import { createDemoCustomerPersonaService } from '../src/demo/identity/customer-persona-service.js';
import { createDemoPlatformPersonaService } from '../src/demo/identity/platform-persona-service.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { PlatformHttpError } from '../src/platform/http/errors.js';
import { createPostgresDemoPersonaRepository } from '../src/persistence/postgres/demo-persona-repository.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '13000000-0000-4000-8000-000000000003';
const OPERATOR_ID = '30000000-0000-4000-8000-000000000001';

function customerSelection() {
  const authority = tenantAuthorizationSnapshot(['employee', 'tenant_admin']);
  return Object.freeze({
    tenantId: TENANT_ID,
    tenantStatus: 'active',
    persona: 'tenant_admin',
    userId: USER_ID,
    securityVersion: 1,
    roles: authority.roles,
    providerIdentity: Object.freeze({ provider: 'demo_customer', reference: 'northwind-admin' }),
  });
}

function platformSelection() {
  return Object.freeze({
    persona: 'support_reader',
    operatorId: OPERATOR_ID,
    securityVersion: 3,
    roles: Object.freeze(['platform_support_reader']),
    tenantIds: Object.freeze([
      TENANT_ID,
      '20000000-0000-4000-8000-000000000002',
    ]),
    targetScope: Object.freeze({ mode: 'allowlist', securityVersion: 3 }),
    providerIdentity: Object.freeze({
      provider: 'demo_platform',
      tenantReference: 'shared-demo-platform',
      subjectReference: 'support-reader',
    }),
    assurance: Object.freeze({ level: 'mfa', authenticationContext: 'demo:mfa' }),
  });
}

test('Demo persona repository reads granted views and projects canonical database authority', async () => {
  const queries = [];
  const pool = {
    async query(query) {
      queries.push(query);
      if (query.name === 'demo-persona-list-tenants') {
        return {
          rowCount: 1,
          rows: [{
            id: TENANT_ID,
            display_name: 'Northwind Demo',
            status: 'active',
            lifecycle_revision: '1',
          }],
        };
      }
      if (query.name === 'demo-persona-find-customer') {
        return {
          rowCount: 1,
          rows: [{
            tenant_id: TENANT_ID,
            tenant_status: 'active',
            persona: 'tenant_admin',
            user_id: USER_ID,
            security_version: '1',
            roles: ['employee', 'tenant_admin'],
            provider: 'demo_customer',
            provider_subject_reference: 'northwind-admin',
          }],
        };
      }
      if (query.name === 'demo-persona-find-platform') {
        return {
          rowCount: 1,
          rows: [{
            persona: 'support_reader',
            operator_id: OPERATOR_ID,
            security_version: '3',
            roles: ['platform_support_reader'],
            tenant_ids: [TENANT_ID, '20000000-0000-4000-8000-000000000002'],
            scope_mode: 'allowlist',
            provider: 'demo_platform',
            provider_tenant_reference: 'shared-demo-platform',
            provider_subject_reference: 'support-reader',
            assurance_level: 'mfa',
            authentication_context: 'demo:mfa',
          }],
        };
      }
      throw new Error(`UNEXPECTED_QUERY:${query.name}`);
    },
  };
  const repository = createPostgresDemoPersonaRepository({ pool });

  assert.deepEqual(await repository.listTenants(), [{
    id: TENANT_ID,
    displayName: 'Northwind Demo',
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
  }]);
  assert.deepEqual(
    await repository.findCustomer({ tenantId: TENANT_ID, persona: 'tenant_admin' }),
    customerSelection(),
  );
  assert.deepEqual(await repository.findPlatform({ persona: 'support_reader' }), platformSelection());

  const sql = queries.map(({ text }) => text).join('\n');
  assert.match(sql, /FROM demo_customer_persona_references AS reference/);
  assert.match(sql, /FROM demo_platform_persona_references AS reference/);
  assert.match(sql, /JOIN user_identity_bindings AS binding/);
  assert.match(sql, /LEFT JOIN platform_operator_tenant_scopes AS scope/);
  assert.doesNotMatch(sql, /FROM demo_persona_references AS reference/);
});

test('customer Demo sessions fail closed when canonical database authority changes', async () => {
  const selection = customerSelection();
  const permissions = tenantAuthorizationSnapshot(selection.roles).permissions;
  const principal = Object.freeze({
    tenantId: selection.tenantId,
    userId: selection.userId,
    roles: selection.roles,
    permissions,
    providerIdentity: selection.providerIdentity,
    session: Object.freeze({ securityVersion: 2 }),
  });
  const service = createDemoCustomerPersonaService({
    sessionService: {
      async issue() { throw new Error('ISSUE_NOT_EXPECTED'); },
      async resolvePrincipal() { return principal; },
      async revoke() { return true; },
      csrfTokenForPrincipal() { return 'csrf'; },
    },
    personaRepository: {
      async listTenants() { return []; },
      async findCustomer() { return selection; },
      async findCustomerForPrincipal() { return selection; },
      async findDefaultCustomer() { return selection; },
    },
  });

  await assert.rejects(service.establish({}), /DEMO_CUSTOMER_SESSION_AUTHORITY_INVALID/);
});

test('Demo persona services reject incomplete session-service ports at composition time', () => {
  const incompleteSessionService = {
    async issue() { return null; },
    async resolvePrincipal() { return null; },
    async revoke() { return true; },
  };
  const customerRepository = {
    async listTenants() { return []; },
    async findCustomer() { return null; },
    async findCustomerForPrincipal() { return null; },
    async findDefaultCustomer() { return null; },
  };
  const platformRepository = {
    async findPlatform() { return null; },
    async findPlatformForPrincipal() { return null; },
  };

  assert.throws(
    () => createDemoCustomerPersonaService({
      sessionService: incompleteSessionService,
      personaRepository: customerRepository,
    }),
    /DEMO_CUSTOMER_SESSION_SERVICE_REQUIRED/,
  );
  assert.throws(
    () => createDemoPlatformPersonaService({
      sessionService: incompleteSessionService,
      personaRepository: platformRepository,
    }),
    /DEMO_PLATFORM_SESSION_SERVICE_REQUIRED/,
  );
});

test('Platform Demo sessions fail closed when canonical roles or scopes change', async () => {
  const persona = platformSelection();
  const principal = Object.freeze({
    operatorId: persona.operatorId,
    securityVersion: persona.securityVersion,
    roles: Object.freeze(['platform_security_auditor']),
    permissions: permissionsForPlatformRoles(['platform_security_auditor']),
    targetScope: persona.targetScope,
    providerIdentity: persona.providerIdentity,
    assurance: Object.freeze({
      ...persona.assurance,
      authenticatedAt: '2026-06-15T09:00:00.000Z',
    }),
  });
  const service = createDemoPlatformPersonaService({
    sessionService: {
      async issue() { throw new Error('ISSUE_NOT_EXPECTED'); },
      async resolvePrincipal() { return principal; },
      async revoke() { return true; },
      csrfTokenForPrincipal() { return 'csrf'; },
    },
    personaRepository: {
      async findPlatform() { return persona; },
      async findPlatformForPrincipal() { return persona; },
    },
  });

  await assert.rejects(service.establish({}), /DEMO_PLATFORM_SESSION_AUTHORITY_INVALID/);
});

test('Demo establish issues defaults only when its own session cookie is genuinely absent', async () => {
  const customerIssues = [];
  const customer = createDemoCustomerPersonaService({
    sessionService: {
      async issue(identity) {
        customerIssues.push(identity);
        return { principal: {}, csrfToken: 'csrf', setCookie: 'cookie' };
      },
      async resolvePrincipal() { return null; },
      async revoke() { return true; },
      csrfTokenForPrincipal() { return 'csrf'; },
    },
    personaRepository: {
      async listTenants() { return []; },
      async findCustomer() { return customerSelection(); },
      async findCustomerForPrincipal() { return null; },
      async findDefaultCustomer() { return customerSelection(); },
    },
  });
  await customer.establish({ headers: {} });
  assert.equal(customerIssues.length, 1);
  for (const cookie of [
    'cm_session=malformed',
    `other=value; cm_session=${'a'.repeat(43)}; cm_session=${'b'.repeat(43)}`,
    'cm_session',
  ]) {
    await assert.rejects(
      customer.establish({ headers: { cookie } }),
      /DEMO_CUSTOMER_SESSION_INVALID/,
    );
  }
  assert.equal(customerIssues.length, 1);

  const platformIssues = [];
  const platform = createDemoPlatformPersonaService({
    sessionService: {
      async issue(identity) {
        platformIssues.push(identity);
        return { principal: {}, csrfToken: 'csrf', setCookie: 'cookie' };
      },
      async resolvePrincipal() { return null; },
      async revoke() { return true; },
      csrfTokenForPrincipal() { return 'csrf'; },
    },
    personaRepository: {
      async findPlatform() { return platformSelection(); },
      async findPlatformForPrincipal() { return null; },
    },
  });
  await platform.establish({ headers: { cookie: 'unrelated=value' } });
  assert.equal(platformIssues.length, 1);
  for (const cookie of [
    'cm_platform_session=expired',
    `cm_platform_session=${'a'.repeat(43)}; cm_platform_session=${'b'.repeat(43)}`,
    'cm_platform_session',
  ]) {
    await assert.rejects(
      platform.establish({ headers: { cookie } }),
      /DEMO_PLATFORM_SESSION_INVALID/,
    );
  }
  assert.equal(platformIssues.length, 1);
});

test('Demo session HTTP routes map invalid or revoked cookies to stable authentication failures', async () => {
  const request = {
    method: 'GET',
    headers: { cookie: 'presented=invalid' },
    async *[Symbol.asyncIterator]() {},
  };
  const response = { setHeader() {}, end() {} };
  const customerModule = createDemoCustomerControlRoutes({
    personaService: {
      async establish() { throw new TypeError('DEMO_CUSTOMER_SESSION_INVALID'); },
      async switch() {},
      async tenants() { return []; },
    },
  });
  const customerHandler = customerModule.createHandler({
    principalGuard: {},
    tenantGuard: {},
    maxBodyBytes: 1024,
    maxResponseBytes: 4096,
  });
  await assert.rejects(
    customerHandler({
      request,
      response,
      parsedUrl: new URL(`https://customer.demo.invalid${DEMO_CUSTOMER_SESSION_PATH}`),
      path: DEMO_CUSTOMER_SESSION_PATH,
      requestId: '11111111-1111-4111-8111-111111111111',
    }),
    (error) => error instanceof ApiError
      && error.statusCode === 401
      && error.code === 'UNAUTHENTICATED',
  );

  const platformModule = createDemoPlatformControlRoutes({
    personaService: {
      async establish() { throw new TypeError('DEMO_PLATFORM_SESSION_INVALID'); },
      async switch() {},
    },
    resetService: { async reset() {} },
  });
  const platformHandler = platformModule.createHandler({
    platformPrincipalGuard: {},
    platformSessionService: {},
    maxBodyBytes: 1024,
    maxResponseBytes: 4096,
  });
  await assert.rejects(
    platformHandler({
      request,
      response,
      parsedUrl: new URL(`https://platform.demo.invalid${DEMO_PLATFORM_SESSION_PATH}`),
      path: DEMO_PLATFORM_SESSION_PATH,
      requestId: '22222222-2222-4222-8222-222222222222',
    }),
    (error) => error instanceof PlatformHttpError
      && error.statusCode === 401
      && error.code === 'PLATFORM_AUTHENTICATION_FAILED'
      && error.securityCategory === 'authentication',
  );
});

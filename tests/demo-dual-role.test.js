import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSION,
  TENANT_ROLE,
  tenantAuthorizationSnapshot,
} from '../src/authorization/policy.js';
import { createDemoCustomerPersonaService } from '../src/demo/identity/customer-persona-service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '13000000-0000-4000-8000-000000000003';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';

function tenantAdminSelection() {
  const authority = tenantAuthorizationSnapshot([
    TENANT_ROLE.EMPLOYEE,
    TENANT_ROLE.TENANT_ADMIN,
  ]);
  return Object.freeze({
    tenantId: TENANT_ID,
    tenantStatus: 'active',
    persona: TENANT_ROLE.TENANT_ADMIN,
    userId: USER_ID,
    securityVersion: 1,
    roles: authority.roles,
    providerIdentity: Object.freeze({
      provider: 'demo_customer',
      reference: 'northwind-admin',
    }),
  });
}

test('dual-role Demo switch derives a union principal and survives authoritative re-establishment', async () => {
  const baseSelection = tenantAdminSelection();
  let resolvedPrincipal = null;
  const issued = [];
  const revoked = [];
  const sessionService = {
    async issue(identity) {
      issued.push(identity);
      resolvedPrincipal = Object.freeze({
        ...identity,
        session: Object.freeze({ securityVersion: identity.securityVersion }),
      });
      return Object.freeze({
        principal: resolvedPrincipal,
        csrfToken: 'csrf-next',
        setCookie: 'cm_session=rotated',
      });
    },
    async resolvePrincipal() { return resolvedPrincipal; },
    async revoke(principal) { revoked.push(principal); return true; },
    csrfTokenForPrincipal() { return 'csrf-established'; },
  };
  const personaRepository = {
    async listTenants() { return []; },
    async findCustomer({ tenantId, persona }) {
      assert.equal(tenantId, TENANT_ID);
      assert.equal(persona, TENANT_ROLE.TENANT_ADMIN);
      return baseSelection;
    },
    async findCustomerForPrincipal({ tenantId, userId }) {
      assert.equal(tenantId, TENANT_ID);
      assert.equal(userId, USER_ID);
      return baseSelection;
    },
    async findDefaultCustomer() { return baseSelection; },
  };
  const service = createDemoCustomerPersonaService({ sessionService, personaRepository });
  const previousPrincipal = Object.freeze({ id: 'previous-session' });

  const switched = await service.switch(previousPrincipal, {
    tenantId: TENANT_ID,
    persona: 'dual_role',
    correlationId: CORRELATION_ID,
  });
  assert.equal(switched.selection.persona, 'dual_role');
  assert.deepEqual(switched.principal.roles, [
    TENANT_ROLE.EMPLOYEE,
    TENANT_ROLE.CONFERENCE_MANAGER,
    TENANT_ROLE.TENANT_ADMIN,
  ]);
  for (const permission of Object.values(PERMISSION)) {
    assert.equal(switched.principal.permissions.includes(permission), true, permission);
  }
  assert.deepEqual(revoked, [previousPrincipal]);
  assert.equal(issued.length, 1);

  const established = await service.establish({ headers: { cookie: 'cm_session=rotated' } }, {
    correlationId: CORRELATION_ID,
  });
  assert.equal(established.selection.persona, 'dual_role');
  assert.deepEqual(established.principal.roles, switched.principal.roles);
  assert.equal(established.csrfToken, 'csrf-established');
  assert.equal(established.setCookie, null);
});

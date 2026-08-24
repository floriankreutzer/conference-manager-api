import assert from 'node:assert/strict';
import test from 'node:test';
import { createJitUserService } from '../src/identity/jit-user-service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_REFERENCE = '44444444-4444-4444-8444-444444444444';
const USER_REFERENCE = '55555555-5555-4555-8555-555555555555';

function auditService() {
  return {
    createActorEvent(value) {
      return Object.freeze({ ...value });
    },
  };
}

function external(overrides = {}) {
  return {
    provider: 'microsoft_entra',
    tenantReference: TENANT_REFERENCE,
    userReference: USER_REFERENCE,
    displayName: 'Ada Lovelace',
    ...overrides,
  };
}

function service({ binding, result, capture } = {}) {
  return createJitUserService({
    bindingRepository: {
      async findActiveBindingByProvider(provider, tenantReference) {
        capture?.bindings?.push({ provider, tenantReference });
        return binding === undefined
          ? { tenantId: TENANT_ID, provider, providerTenantReference: tenantReference }
          : binding;
      },
    },
    userRepository: {
      async resolveOrProvision(value) {
        capture?.provision?.push(value);
        return result || {
          status: 'resolved',
          identity: {
            tenantId: TENANT_ID,
            userId: USER_ID,
            displayName: value.displayName,
            active: true,
            securityVersion: 1,
            created: true,
            profileChanged: false,
          },
        };
      },
    },
    auditService: auditService(),
    clock: () => Date.parse('2026-08-24T14:00:00.000Z'),
    idFactory: () => USER_ID,
  });
}

test('first JIT login emits only the safe Employee authorization snapshot', async () => {
  const capture = { bindings: [], provision: [] };
  const resolved = await service({ capture }).resolve(external({
    email: 'admin@example.com',
    roles: ['tenant_admin'],
    permissions: ['tenant:users:manage'],
  }), { correlationId: CORRELATION_ID });

  assert.equal(resolved.status, 'authenticated');
  assert.deepEqual(resolved.trustedIdentity, {
    userId: USER_ID,
    tenantId: TENANT_ID,
    providerIdentity: {
      provider: 'microsoft_entra',
      reference: `${TENANT_REFERENCE}:${USER_REFERENCE}`,
    },
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  });
  assert.deepEqual(capture.bindings, [{
    provider: 'microsoft_entra',
    tenantReference: TENANT_REFERENCE,
  }]);
  assert.equal(capture.provision[0].providerTenantReference, TENANT_REFERENCE);
  assert.equal(Object.hasOwn(capture.provision[0], 'email'), false);
  assert.equal(Object.hasOwn(capture.provision[0], 'roles'), false);
  assert.equal(capture.provision[0].provisionAuditEvent.action, 'tenant.user.provisioned');
});

test('unknown provider tenant requires onboarding and never provisions a user', async () => {
  let calls = 0;
  const value = service({
    binding: null,
    capture: { provision: { push() { calls += 1; } } },
  });
  assert.deepEqual(await value.resolve(external(), { correlationId: CORRELATION_ID }), {
    status: 'onboarding_required',
  });
  assert.equal(calls, 0);
});

test('disabled and unavailable local states fail closed as authentication denial', async () => {
  for (const status of ['user_disabled', 'tenant_unavailable']) {
    const resolved = await service({ result: { status } }).resolve(external(), {
      correlationId: CORRELATION_ID,
    });
    assert.deepEqual(resolved, { status: 'authentication_denied' });
  }
});

test('malformed provider identity fails closed before binding lookup', async () => {
  const invalid = [
    null,
    {},
    external({ tenantReference: '../../tenant' }),
    external({ userReference: '' }),
    external({ displayName: null }),
    external({ displayName: ' name with outer whitespace ' }),
  ];
  for (const identity of invalid) {
    const resolved = await service().resolve(identity, { correlationId: CORRELATION_ID });
    assert.deepEqual(resolved, { status: 'authentication_denied' });
  }
});

test('profile update audit factory is user-bound and contains no display-name PII', async () => {
  const capture = { provision: [] };
  await service({ capture }).resolve(external({ displayName: 'Ada Byron' }), {
    correlationId: CORRELATION_ID,
  });
  const event = capture.provision[0].profileAuditEventFor(USER_ID);
  assert.equal(event.action, 'tenant.user.profile_updated');
  assert.equal(event.targetId, USER_ID);
  assert.equal(event.actorUserId, USER_ID);
  assert.deepEqual(event.metadata, { displayNameChanged: true, source: 'jit' });
  assert.equal(JSON.stringify(event).includes('Ada Byron'), false);
});

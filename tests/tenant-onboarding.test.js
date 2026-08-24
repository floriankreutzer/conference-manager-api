import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ENTRA_IDENTITY_PROVIDER } from '../src/identity/entra-client.js';
import { createPendingProviderIdentityResolver } from '../src/identity/provider-identity-resolver.js';
import {
  TENANT_CLAIM_COOKIE_NAME,
  readTenantClaimCookie,
} from '../src/onboarding/claim-cookie.js';
import { OnboardingDeniedError } from '../src/onboarding/errors.js';
import { createTenantOnboardingService } from '../src/onboarding/tenant-onboarding-service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const BINDING_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const PROVIDER_TENANT = '55555555-5555-4555-8555-555555555555';
const PROVIDER_USER = '66666666-6666-4666-8666-666666666666';
const INVITATION_TOKEN = 'I'.repeat(43);
const CLAIM_TOKEN = 'C'.repeat(43);
const NOW_MS = Date.parse('2026-08-24T12:00:00.000Z');
const SECRET = 'tenant-onboarding-test-secret-at-least-32-bytes';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function auditService() {
  return {
    createActorEvent(event) {
      return Object.freeze({ ...event });
    },
  };
}

function repository(overrides = {}) {
  return {
    async createTenantInvitation() { return { tenantId: TENANT_ID, invitationId: INVITATION_ID }; },
    async findOpenInvitationByTokenHash() { return { id: INVITATION_ID, tenantId: TENANT_ID }; },
    async prepareClaim() { return true; },
    async findPendingClaim() {
      return {
        tenantId: TENANT_ID,
        tenantDisplayName: 'Contoso',
        provider: ENTRA_IDENTITY_PROVIDER,
        providerTenantReference: PROVIDER_TENANT,
        providerUserReference: PROVIDER_USER,
        displayName: 'Customer Admin',
        expiresAt: new Date(NOW_MS + 600_000),
      };
    },
    async confirmClaim() { return { tenantId: TENANT_ID, tenantStatus: 'onboarding' }; },
    async findActiveBindingByTenantId() {
      return { tenantId: TENANT_ID, provider: ENTRA_IDENTITY_PROVIDER, status: 'active' };
    },
    async unbindActive() {
      return { tenantId: TENANT_ID, provider: ENTRA_IDENTITY_PROVIDER, status: 'unbound' };
    },
    ...overrides,
  };
}

function service({ repositoryValue, authorizeOperator = async () => true } = {}) {
  const tokens = [INVITATION_TOKEN, CLAIM_TOKEN];
  const ids = [TENANT_ID, INVITATION_ID, BINDING_ID];
  return createTenantOnboardingService({
    repository: repositoryValue || repository(),
    auditService: auditService(),
    authorizeOperator,
    transactionSecret: SECRET,
    publicOrigin: 'https://app.example.com',
    clock: () => NOW_MS,
    randomToken: () => tokens.shift(),
    randomId: () => ids.shift(),
  });
}

function externalIdentity(overrides = {}) {
  return {
    provider: ENTRA_IDENTITY_PROVIDER,
    tenantReference: PROVIDER_TENANT,
    userReference: PROVIDER_USER,
    displayName: 'Customer Admin',
    ...overrides,
  };
}

test('operator invitation creation returns token once while persistence receives only its hash', async () => {
  let captured;
  const repositoryValue = repository({
    async createTenantInvitation(value) {
      captured = value;
      return { tenantId: TENANT_ID, invitationId: INVITATION_ID };
    },
  });
  const created = await service({ repositoryValue }).createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName: 'Contoso',
    correlationId: CORRELATION_ID,
  });
  assert.equal(created.tenantId, TENANT_ID);
  assert.equal(created.invitationToken, INVITATION_TOKEN);
  assert.equal(captured.tokenHash, sha256(INVITATION_TOKEN));
  assert.equal(JSON.stringify(captured).includes(INVITATION_TOKEN), false);
  assert.equal(captured.auditEvent.action, 'tenant.onboarding.invited');
  assert.equal(captured.auditEvent.metadata.actorType, 'platform_operator');
});

test('operator mutation fails closed when no platform authorizer grants it', async () => {
  let writes = 0;
  const repositoryValue = repository({
    async createTenantInvitation() {
      writes += 1;
      return null;
    },
  });
  await assert.rejects(
    service({ repositoryValue, authorizeOperator: async () => false }).createTenantInvitation({
      operatorContext: { kind: 'untrusted' },
      displayName: 'Contoso',
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof OnboardingDeniedError && error.code === 'OPERATOR_NOT_AUTHORIZED',
  );
  assert.equal(writes, 0);
});

test('invitation and validated Entra identity become a short-lived browser claim, not a session', async () => {
  let prepared;
  const repositoryValue = repository({
    async prepareClaim(value) {
      prepared = value;
      return true;
    },
  });
  const onboarding = service({ repositoryValue });
  const invitation = await onboarding.beginInvitation({ invitationToken: INVITATION_TOKEN });
  assert.equal(invitation.invitationId, INVITATION_ID);

  const claim = await onboarding.prepareClaim({
    invitationId: invitation.invitationId,
    externalIdentity: externalIdentity(),
    correlationId: CORRELATION_ID,
  });
  assert.equal(claim.status, 'claim_confirmation_required');
  assert.equal(prepared.providerTenantReference, PROVIDER_TENANT);
  assert.equal(prepared.providerUserReference, PROVIDER_USER);
  assert.equal(prepared.tokenHash, sha256(CLAIM_TOKEN));
  assert.equal(JSON.stringify(prepared).includes(CLAIM_TOKEN), false);
  assert.match(claim.setCookie, /^cm_tenant_claim=/);
  assert.match(claim.setCookie, /HttpOnly/);
  assert.match(claim.setCookie, /SameSite=Strict/);
  assert.match(claim.setCookie, /Secure/);
  assert.equal(claim.setCookie.includes('cm_session='), false);
});

test('claim confirmation requires server-derived CSRF and exposes no provider tenant reference', async () => {
  let confirmed;
  const repositoryValue = repository({
    async confirmClaim(value) {
      confirmed = value;
      return { tenantId: TENANT_ID, tenantStatus: 'onboarding' };
    },
  });
  const onboarding = service({ repositoryValue });
  await onboarding.createTenantInvitation({
    operatorContext: { kind: 'platform-operator' },
    displayName: 'Contoso',
    correlationId: CORRELATION_ID,
  });
  const prepared = await onboarding.prepareClaim({
    invitationId: INVITATION_ID,
    externalIdentity: externalIdentity(),
    correlationId: CORRELATION_ID,
  });
  const claimToken = readTenantClaimCookie({ cookie: prepared.setCookie });
  const status = await onboarding.claimStatus({ claimToken });
  assert.deepEqual(status.tenant, { displayName: 'Contoso' });
  assert.equal(JSON.stringify(status).includes(PROVIDER_TENANT), false);
  assert.equal(JSON.stringify(status).includes(TENANT_ID), false);

  await assert.rejects(
    onboarding.confirmClaim({
      claimToken,
      csrfToken: 'X'.repeat(43),
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof OnboardingDeniedError && error.code === 'ONBOARDING_CSRF_INVALID',
  );
  const result = await onboarding.confirmClaim({
    claimToken,
    csrfToken: status.csrfToken,
    correlationId: CORRELATION_ID,
  });
  assert.equal(result.status, 'claimed');
  assert.equal(result.tenantStatus, 'onboarding');
  assert.equal(confirmed.auditEvent.action, 'tenant.identity.claimed');
});

test('claim cookie parser rejects duplicate, malformed and oversized values', () => {
  assert.equal(
    readTenantClaimCookie({ cookie: `${TENANT_CLAIM_COOKIE_NAME}=${CLAIM_TOKEN}` }),
    CLAIM_TOKEN,
  );
  assert.equal(
    readTenantClaimCookie({
      cookie: `${TENANT_CLAIM_COOKIE_NAME}=${CLAIM_TOKEN}; ${TENANT_CLAIM_COOKIE_NAME}=${CLAIM_TOKEN}`,
    }),
    null,
  );
  assert.equal(readTenantClaimCookie({ cookie: `${TENANT_CLAIM_COOKIE_NAME}=invalid` }), null);
  assert.equal(readTenantClaimCookie({ cookie: 'x'.repeat(8_193) }), null);
});

test('provider resolver uses only trusted OIDC invitation context to enter the claim flow', async () => {
  let captured;
  const resolver = createPendingProviderIdentityResolver({
    onboardingService: {
      async prepareClaim(value) {
        captured = value;
        return { status: 'claim_confirmation_required', setCookie: 'cm_tenant_claim=opaque' };
      },
    },
  });
  assert.deepEqual(await resolver.resolve(externalIdentity(), { correlationId: CORRELATION_ID }), {
    status: 'onboarding_required',
  });
  const claimed = await resolver.resolve(externalIdentity(), {
    correlationId: CORRELATION_ID,
    onboardingInvitationId: INVITATION_ID,
  });
  assert.equal(claimed.status, 'claim_confirmation_required');
  assert.equal(captured.invitationId, INVITATION_ID);
  assert.equal(captured.externalIdentity.tenantReference, PROVIDER_TENANT);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingProviderIdentityResolver } from '../src/identity/provider-identity-resolver.js';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const EXTERNAL = Object.freeze({
  provider: 'microsoft_entra',
  tenantReference: '33333333-3333-4333-8333-333333333333',
  userReference: '44444444-4444-4444-8444-444444444444',
  displayName: 'Pilot User',
});

test('normal provider login delegates to JIT while invitation login remains onboarding-owned', async () => {
  const calls = [];
  const resolver = createPendingProviderIdentityResolver({
    jitUserService: {
      async resolve(externalIdentity, context) {
        calls.push({ kind: 'jit', externalIdentity, context });
        return { status: 'authenticated', trustedIdentity: { marker: 'jit' } };
      },
    },
    onboardingService: {
      async prepareClaim(value) {
        calls.push({ kind: 'claim', value });
        return { status: 'claim_confirmation_required', setCookie: 'cm_tenant_claim=opaque' };
      },
    },
  });

  const normal = await resolver.resolve(EXTERNAL, { correlationId: CORRELATION_ID });
  assert.equal(normal.status, 'authenticated');
  assert.equal(normal.trustedIdentity.marker, 'jit');
  assert.deepEqual(calls[0], {
    kind: 'jit',
    externalIdentity: EXTERNAL,
    context: { correlationId: CORRELATION_ID },
  });

  const claim = await resolver.resolve(EXTERNAL, {
    correlationId: CORRELATION_ID,
    onboardingInvitationId: INVITATION_ID,
  });
  assert.equal(claim.status, 'claim_confirmation_required');
  assert.equal(calls[1].kind, 'claim');
  assert.equal(calls[1].value.invitationId, INVITATION_ID);
  assert.equal(calls.filter((entry) => entry.kind === 'jit').length, 1);
});

test('resolver fails closed for invalid correlation and missing configured JIT service', async () => {
  const resolver = createPendingProviderIdentityResolver();
  await assert.rejects(
    resolver.resolve(EXTERNAL, { correlationId: 'not-a-uuid' }),
    /IDENTITY_CORRELATION_INVALID/,
  );
  assert.deepEqual(await resolver.resolve(EXTERNAL, { correlationId: CORRELATION_ID }), {
    status: 'onboarding_required',
  });
});

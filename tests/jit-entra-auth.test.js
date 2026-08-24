import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntraAuthService } from '../src/identity/entra-auth-service.js';

const STATE = 'S'.repeat(43);
const NONCE = 'N'.repeat(43);
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'jit-entra-auth-test-secret-at-least-32-bytes';

function service({ resolution }) {
  let issued = 0;
  const value = createEntraAuthService({
    repository: {
      async create() {},
      async consume() {
        return { nonceHash: 'a'.repeat(64), onboardingInvitationId: null };
      },
    },
    entraClient: {
      async authorizationUrl() { return 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'; },
      async redeemAuthorizationCode() {
        return {
          provider: 'microsoft_entra',
          tenantReference: '22222222-2222-4222-8222-222222222222',
          userReference: '33333333-3333-4333-8333-333333333333',
          displayName: 'Pilot User',
        };
      },
    },
    identityResolver: {
      async resolve() { return resolution; },
    },
    sessionService: {
      async issue() {
        issued += 1;
        throw new Error('SESSION_MUST_NOT_BE_ISSUED');
      },
    },
    transactionSecret: SECRET,
    publicOrigin: 'https://app.example.com',
    clock: () => Date.parse('2026-08-24T14:00:00.000Z'),
    randomToken: (() => {
      const values = [STATE, NONCE];
      return () => values.shift();
    })(),
  });
  return { value, issued: () => issued };
}

test('JIT authentication denial is normalized before application session issuance', async () => {
  const fixture = service({ resolution: { status: 'authentication_denied' } });
  const started = await fixture.value.start({ correlationId: CORRELATION_ID });
  const binding = started.setCookie.match(/^cm_oidc_tx=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(binding);
  const completed = await fixture.value.complete({
    state: STATE,
    code: 'valid-code',
    browserBinding: binding,
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(completed, { status: 'authentication_rejected' });
  assert.equal(fixture.issued(), 0);
});

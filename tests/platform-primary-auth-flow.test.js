import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { createPlatformEntraPrimaryAuthService } from '../src/platform/identity/entra-auth-service.js';
import { createPlatformEntraPrimaryClient } from '../src/platform/identity/entra-client.js';
import { readPlatformEntraTransactionCookie } from '../src/platform/identity/entra-transaction-cookie.js';

function fixture({ redeemFailure = null, realPrimaryClient = null } = {}) {
  const transactions = new Map();
  const calls = { redeem: 0, startPasskey: 0, failures: [], contexts: [], consumed: 0 };
  let transaction = null; let result = { status: 'passkey_required', state: 'pending', options: {}, setCookie: 'preauth-cookie' };
  const primaryAssertion = Object.freeze({ status: 'primary_verified' });
  const service = createPlatformEntraPrimaryAuthService({
    repository: {
      async create(value) { transaction = value; transactions.set(value.stateHash, value); },
      async consume(value) {
        calls.consumed += 1;
        const record = transactions.get(value.stateHash);
        if (!record || record.securityEpoch !== value.securityEpoch) return null;
        transactions.delete(value.stateHash); return record;
      },
    },
    entraClient: realPrimaryClient || {
      verifyPrimary() {},
      async authorizationUrl(value) {
        calls.contexts.push(value.authenticationContext);
        const url = new URL('https://login.microsoftonline.com/directory/oauth2/v2.0/authorize');
        url.searchParams.set('state', value.state); return url.toString();
      },
      async redeemAuthorizationCode(value) {
        calls.redeem += 1;
        assert.equal(value.authenticationContext, undefined);
        assert.equal(value.expectedNonceHash, transaction.nonceHash);
        if (redeemFailure) throw redeemFailure;
        return primaryAssertion;
      },
    },
    passkeyAuthService: { async startLogin(assertion, context) {
      calls.startPasskey += 1;
      if (realPrimaryClient) {
        const identity = await realPrimaryClient.verifyPrimary(assertion);
        assert.equal(identity.provider, 'microsoft_entra_platform');
        assert.equal(identity.roles, undefined);
        await assert.rejects(realPrimaryClient.verifyPrimary(assertion), /NOT_VERIFIED/);
      } else assert.equal(assertion, primaryAssertion);
      assert.equal(context.correlationId, transaction.correlationId);
      return result;
    } },
    auditService: { createUnmappedAuthenticationFailure: value => value, async record(value) { calls.failures.push(value); } },
    transactionSecret: 't'.repeat(48), publicOrigin: 'https://platform.example.com', securityEpoch: 8,
    randomToken: () => randomBytes(32).toString('base64url'),
  });
  async function start() {
    const started = await service.start();
    return { state: new URL(started.authorizationUrl).searchParams.get('state'), code: 'code',
      browserBinding: readPlatformEntraTransactionCookie({ cookie: started.setCookie.split(';')[0] }) };
  }
  return { service, calls, start, record: () => transaction, setResult: value => { result = value; } };
}

test('Microsoft primary callback consumes browser-bound OIDC state and returns only the pending passkey flow', async () => {
  const f = fixture();
  const input = await f.start();
  assert.equal(f.record().authenticationContext, 'cm:pk:primary:v1');
  assert.equal(f.record().ttlSeconds, 300);
  assert.deepEqual(f.calls.contexts, [undefined]);
  assert.equal((await f.service.complete(input)).status, 'passkey_required');
  assert.equal(f.calls.redeem, 1);
  assert.equal(f.calls.startPasskey, 1);
  await assert.rejects(f.service.complete(input), /OIDC_STATE_INVALID/);
  assert.equal(f.calls.redeem, 1);
  await assert.rejects(f.service.start({ purpose: 'step_up' }), /OIDC_PURPOSE_INVALID/);
});

test('real primary adapter and callback accept independent fresh times but reject stale claims without a pending flow', async () => {
  const seconds = Date.parse('2026-10-23T00:00:00Z') / 1000;
  const directory = '22222222-2222-4222-8222-222222222222';
  const clientId = '11111111-1111-4111-8111-111111111111';
  const authority = `https://login.microsoftonline.com/${directory}`;
  const redirect = 'https://platform.example.com/api/v1/platform/auth/microsoft/callback';
  for (const [changes, reasonCode] of [
    [{ iat: seconds - 300, auth_time: seconds }, null],
    [{ iat: seconds - 361, auth_time: seconds }, 'provider_issued_at_not_fresh'],
    [{ iat: seconds, auth_time: seconds - 361 }, 'provider_authentication_not_fresh'],
    [{ iat: seconds, auth_time: seconds + 60, exp: seconds + 60 }, 'provider_authentication_expiry_order_invalid'],
  ]) {
    const realPrimaryClient = createPlatformEntraPrimaryClient({
      clientId, clientSecret: 's'.repeat(48), tenantReference: directory, authority,
      redirectUri: redirect, publicOrigin: 'https://platform.example.com', clock: () => seconds * 1000,
      application: {
        async getAuthCodeUrl(request) {
          const url = new URL(`${authority}/oauth2/v2.0/authorize`);
          for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirect,
            response_type: 'code', response_mode: 'query', scope: 'openid profile', max_age: '300',
            state: request.state, nonce: request.nonce, code_challenge: request.codeChallenge,
            code_challenge_method: 'S256', claims: request.claims })) url.searchParams.set(key, value);
          return url.toString();
        },
        async acquireTokenByCode(request) {
          return { idTokenClaims: { aud: clientId, tid: directory,
            oid: '33333333-3333-4333-8333-333333333333', iss: `${authority}/v2.0`,
            nonce: request.nonce, ver: '2.0', exp: seconds + 3600, ...changes } };
        },
      },
    });
    const f = fixture({ realPrimaryClient }); const input = await f.start();
    if (reasonCode === null) {
      const pending = await f.service.complete(input);
      assert.equal(pending.status, 'passkey_required');
      assert.equal(pending.principal, undefined);
      assert.equal(f.calls.startPasskey, 1);
      assert.deepEqual(f.calls.failures, []);
    } else {
      await assert.rejects(f.service.complete(input), /PLATFORM_ENTRA_/);
      assert.equal(f.calls.startPasskey, 0);
      assert.deepEqual(f.calls.failures, [{ correlationId: f.record().correlationId, reasonCode }]);
    }
    await assert.rejects(f.service.complete(input), /OIDC_STATE_INVALID/);
  }
});

test('primary callback rejects a foreign browser before state consumption or provider exchange', async () => {
  const f = fixture();
  const input = await f.start();
  await assert.rejects(f.service.complete({ ...input, browserBinding: 'X'.repeat(43) }), /BROWSER_BINDING_INVALID/);
  assert.equal(f.calls.consumed, 0);
  assert.equal(f.calls.redeem, 0);
  assert.equal(f.calls.startPasskey, 0);
  assert.equal((await f.service.complete(input)).status, 'passkey_required');
});

test('primary callback rejects old context transactions, wrong epochs and provider cancellation without a passkey session', async () => {
  for (const mutate of [r => { r.authenticationContext = 'legacy-c1'; }, r => { r.securityEpoch = 7; }]) {
    const f = fixture(); const input = await f.start(); mutate(f.record());
    await assert.rejects(f.service.complete(input), /PRIMARY_TRANSACTION_INVALID|OIDC_STATE_INVALID/);
    assert.equal(f.calls.redeem, 0);
    assert.equal(f.calls.startPasskey, 0);
  }
  const f = fixture(); const input = await f.start();
  assert.deepEqual(await f.service.complete({ ...input, code: undefined, providerError: 'access_denied' }),
    { status: 'authentication_rejected' });
  assert.equal(f.calls.startPasskey, 0);
});

test('miscomposed primary flow cannot accidentally return a business session instead of a passkey challenge', async () => {
  const f = fixture(); const input = await f.start();
  f.setResult({ status: 'authenticated', principal: { roles: ['platform_security_admin'] }, setCookie: 'unsafe-session' });
  await assert.rejects(f.service.complete(input), /PRIMARY_PENDING_RESULT_INVALID/);
  assert.equal(f.calls.failures.at(-1).reasonCode, 'assertion_rejected');
});

test('verified primary can return only pending independent enrollment when no key exists', async () => {
  const f = fixture(); const input = await f.start();
  f.setResult({ status: 'enrollment_required', state: 'pending', setCookie: 'preauth-cookie' });
  assert.equal((await f.service.complete(input)).status, 'enrollment_required');
  assert.equal(f.calls.startPasskey, 1);
});

test('primary redemption audit separates exchange, nonce and freshness failures without opening a passkey flow', async () => {
  for (const [code, reasonCode] of [
    ['PLATFORM_ENTRA_CODE_REDEMPTION_FAILED', 'provider_code_exchange_failed'],
    ['PLATFORM_ENTRA_NONCE_INVALID', 'provider_nonce_invalid'],
    ['PLATFORM_ENTRA_AUTHENTICATION_TIME_INVALID', 'provider_authentication_time_invalid'],
    ['PLATFORM_ENTRA_AUTHENTICATION_NOT_FRESH', 'provider_authentication_not_fresh'],
    ['PLATFORM_ISSUER_MISMATCH', 'provider_issuer_mismatch'],
    ['PLATFORM_ENTRA_TOKEN_LIFETIME_INVALID', 'provider_token_lifetime_invalid'],
    ['PLATFORM_ENTRA_ISSUED_AT_NEGATIVE', 'provider_issued_at_negative'],
    ['PLATFORM_ENTRA_AUTHENTICATION_TIME_NEGATIVE', 'provider_authentication_time_negative'],
    ['PLATFORM_ENTRA_TOKEN_EXPIRY_ORDER_INVALID', 'provider_token_expiry_order_invalid'],
    ['PLATFORM_ENTRA_AUTHENTICATION_ORDER_INVALID', 'provider_authentication_order_invalid'],
    ['PLATFORM_ENTRA_ISSUED_AT_NOT_FRESH', 'provider_issued_at_not_fresh'],
    ['PLATFORM_ENTRA_AUTHENTICATION_EXPIRY_ORDER_INVALID', 'provider_authentication_expiry_order_invalid'],
  ]) {
    const failure = new PlatformIdentityError(code);
    const f = fixture({ redeemFailure: failure }); const input = await f.start();
    await assert.rejects(f.service.complete(input), error => error === failure);
    assert.deepEqual(f.calls.failures, [{ correlationId: f.record().correlationId, reasonCode }]);
    assert.equal(f.calls.startPasskey, 0);
    assert.equal(f.calls.redeem, 1);
    await assert.rejects(f.service.complete(input), /OIDC_STATE_INVALID/);
    assert.equal(f.calls.redeem, 1);
  }
});

test('unknown, forged and prototype-named provider errors retain only the fixed generic audit reason', async () => {
  for (const failure of [new Error('SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD'),
    { code: 'PLATFORM_ENTRA_NONCE_INVALID', message: 'SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD' },
    new PlatformIdentityError('__proto__'), new PlatformIdentityError('constructor'),
    new PlatformIdentityError('SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD')]) {
    const f = fixture({ redeemFailure: failure }); const input = await f.start();
    await assert.rejects(f.service.complete(input), error => error === failure);
    assert.deepEqual(f.calls.failures, [{ correlationId: f.record().correlationId, reasonCode: 'provider_redeem_failed' }]);
    assert.equal(JSON.stringify(f.calls.failures).includes('SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD'), false);
    assert.equal(f.calls.startPasskey, 0);
  }
});

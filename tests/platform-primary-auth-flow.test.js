import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPlatformEntraPrimaryAuthService } from '../src/platform/identity/entra-auth-service.js';
import { readPlatformEntraTransactionCookie } from '../src/platform/identity/entra-transaction-cookie.js';

function fixture() {
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
    entraClient: {
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
        return primaryAssertion;
      },
    },
    passkeyAuthService: { async startLogin(assertion, context) {
      calls.startPasskey += 1;
      assert.equal(assertion, primaryAssertion);
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

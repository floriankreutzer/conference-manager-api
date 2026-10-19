import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeInvitationRecipient } from '../src/domain/invitation-recipient.js';
import { createEmailCodeProofFactory } from '../src/identity/email-code-proof.js';
import { createResendEmailClient, TransactionalEmailError } from '../src/integrations/resend-email-client.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const SECRET = 'synthetic-email-proof-key-only-for-tests-00001';
const CONFIG = { apiKey: 're_synthetic_test_key_0000000001', sender: 'support@example.com', environment: 'int' };
const MESSAGE = { recipient: 'Invited@example.com', subject: 'Your sign-in code', text: 'Code: 12345678', deliveryId: UUID };
const CONTEXT = { challengeId: UUID, tenantId: OTHER, userId: THIRD };

test('synthetic Demo compositions cannot import the real Resend delivery adapter', () => {
  for (const surface of ['customer', 'platform']) {
    const violations = architectureConsolidationBoundaryViolations({
      [`src/demo/${surface}-composition.js`]: "import '../integrations/resend-email-client.js';",
      'src/integrations/resend-email-client.js': 'export const adapter = true;',
    });
    assert.ok(violations.some((value) => value.includes('must not import Production identity/provider')));
  }
});

function proofFactory(overrides = {}) {
  return createEmailCodeProofFactory({ secret: SECRET, environment: 'int', ...overrides });
}

function receipt() {
  return Response.json({ id: UUID });
}

test('invitation addresses normalize only the domain and never merge case, dot or plus aliases', () => {
  assert.equal(normalizeInvitationRecipient('User+demo@EXAMPLE.COM'), 'User+demo@example.com');
  assert.notEqual(normalizeInvitationRecipient('User@example.com'), normalizeInvitationRecipient('user@example.com'));
  assert.notEqual(normalizeInvitationRecipient('u.ser@example.com'), normalizeInvitationRecipient('user@example.com'));
  for (const address of [' user@example.com', 'user@example.com ', 'a..b@example.com', '.a@example.com',
    'a.@example.com', 'a@localhost', 'a@127.0.0.1', 'a@-bad.example', 'a@bad-.example', 'a@a..com',
    'a@bad.example\r\nBcc: other@example.com', 'Name <a@example.com>', 'a@@example.com', 'ä@example.com',
    `${'a'.repeat(65)}@example.com`, null, {}, ['a@example.com']]) {
    assert.throws(() => normalizeInvitationRecipient(address), /INVITATION_RECIPIENT_INVALID/);
  }
});

test('proofs bind the code and initiating browser to environment, challenge, Tenant and User', () => {
  const factory = proofFactory();
  const proof = factory.issue(CONTEXT);
  assert.match(proof.code, /^\d{8}$/);
  assert.match(proof.browserToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(factory.matches({ context: CONTEXT, ...proof }), true);
  for (const context of [{ ...CONTEXT, challengeId: OTHER }, { ...CONTEXT, tenantId: UUID }, { ...CONTEXT, userId: OTHER }]) {
    assert.equal(factory.matches({ context, ...proof }), false);
  }
  for (const environment of ['dev', 'prod']) {
    assert.equal(proofFactory({ environment }).matches({ context: CONTEXT, ...proof }), false);
  }
  assert.equal(proofFactory({ secret: `${SECRET}-other` }).matches({ context: CONTEXT, ...proof }), false);
  assert.equal(factory.matches({ context: CONTEXT, ...proof, browserToken: 'b'.repeat(43) }), false);
  const otherCode = proof.code === '00000000' ? '11111111' : '00000000';
  assert.equal(factory.matches({ context: CONTEXT, ...proof, code: otherCode }), false);
  assert.equal(factory.matches({ context: CONTEXT, ...proof, codeVerifier: proof.browserVerifier }), false);
});

test('independent secure challenges differ; malformed proof/context/configuration fails closed', () => {
  const factory = proofFactory();
  const first = factory.issue(CONTEXT);
  assert.notEqual(first.browserToken, factory.issue(CONTEXT).browserToken);
  for (const change of [{ code: 12345678 }, { code: '1234567' }, { code: '12345678\n' },
    { browserToken: null }, { codeVerifier: 'a' }, { browserVerifier: 'f'.repeat(65) }]) {
    assert.equal(factory.matches({ context: CONTEXT, ...first, ...change }), false);
  }
  for (const context of [null, { ...CONTEXT, role: 'tenant_admin' }, { ...CONTEXT, userId: 'invalid' }]) {
    assert.throws(() => factory.issue(context), /EMAIL_CODE_CONTEXT_INVALID/);
  }
  for (const overrides of [{ secret: 'short' }, { environment: 'demo' }, { secret: `${SECRET}\n` }]) {
    assert.throws(() => proofFactory(overrides), /EMAIL_CODE_CONFIGURATION_INVALID/);
  }
  assert.throws(() => proofFactory({ codeFactory: () => '123' }).issue(CONTEXT), /EMAIL_CODE_RANDOM_FACTORY_INVALID/);
});

test('Resend uses one fixed HTTPS endpoint, server sender, bounded signal and environment-separated idempotency', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return receipt(); };
  const client = createResendEmailClient({ ...CONFIG, fetchImpl });
  assert.deepEqual(await client.send(MESSAGE), { status: 'accepted', messageId: UUID });
  await client.send(MESSAGE);
  const [url, request] = calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.signal instanceof AbortSignal, true);
  assert.equal(request.signal.aborted, false);
  assert.equal(request.headers.Authorization, `Bearer ${CONFIG.apiKey}`);
  assert.deepEqual(JSON.parse(request.body), {
    from: CONFIG.sender, to: [MESSAGE.recipient], subject: MESSAGE.subject, text: MESSAGE.text,
  });
  const key = request.headers['Idempotency-Key'];
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, calls[1][1].headers['Idempotency-Key']);
  await client.send({ ...MESSAGE, deliveryId: OTHER });
  assert.notEqual(key, calls[2][1].headers['Idempotency-Key']);
  await createResendEmailClient({ ...CONFIG, environment: 'prod', fetchImpl }).send(MESSAGE);
  assert.notEqual(key, calls[3][1].headers['Idempotency-Key']);
});

test('Resend rejects caller-selected destinations, sender/header injection and oversized messages before network access', async () => {
  let calls = 0;
  const client = createResendEmailClient({ ...CONFIG, fetchImpl: async () => { calls += 1; return receipt(); } });
  for (const change of [{ url: 'https://evil.example' }, { from: 'other@example.com' }, { recipient: 'a@example.com\n' },
    { recipient: ['a@example.com'] }, { subject: 'a\r\nBcc: victim@example.com' }, { subject: ' ' },
    { text: 'a'.repeat(16_385) }, { text: '\u0000' }, { deliveryId: 'unknown' }]) {
    await assert.rejects(client.send({ ...MESSAGE, ...change }), /EMAIL_MESSAGE_INVALID/);
  }
  assert.equal(calls, 0);
  for (const overrides of [{ apiKey: '' }, { apiKey: `${CONFIG.apiKey}\n` }, { sender: 'Name <a@example.com>' },
    { environment: 'demo' }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { fetchImpl: null }]) {
    assert.throws(() => createResendEmailClient({ ...CONFIG, ...overrides }), /EMAIL_CONFIGURATION_INVALID/);
  }
});

test('Resend distinguishes rate limits, authorization, conflicts and provider failures without copying provider payloads', async () => {
  for (const [status, code, retryable] of [[401, 'EMAIL_PROVIDER_NOT_AUTHORIZED', false],
    [403, 'EMAIL_PROVIDER_NOT_AUTHORIZED', false], [409, 'EMAIL_DELIVERY_CONFLICT', false],
    [422, 'EMAIL_PROVIDER_REJECTED', false], [429, 'EMAIL_RATE_LIMITED', true], [500, 'EMAIL_PROVIDER_UNAVAILABLE', true]]) {
    let calls = 0;
    const client = createResendEmailClient({ ...CONFIG, fetchImpl: async () => {
      calls += 1;
      return new Response('confidential-provider-payload', { status, headers: { 'retry-after': '25' } });
    } });
    await assert.rejects(client.send(MESSAGE), (error) => {
      assert.equal(error instanceof TransactionalEmailError, true);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.retryAfterMs, status === 429 ? 25_000 : null);
      assert.equal(JSON.stringify(error).includes('confidential'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
  const client = createResendEmailClient({ ...CONFIG, fetchImpl: async () => { throw new Error(CONFIG.apiKey); } });
  await assert.rejects(client.send(MESSAGE), (error) => {
    assert.equal(error.code, 'EMAIL_PROVIDER_UNAVAILABLE');
    assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(CONFIG.apiKey), false);
    return true;
  });
});

test('malformed, excessive, unexpected and redirected receipts never report delivery success', async () => {
  const responses = [
    Response.json({ id: 'invalid' }), Response.json({ id: UUID, extra: 'unknown' }),
    Response.json([UUID]), new Response('not-json', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '5000' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '-1' } }),
    { status: 200, redirected: true }, { status: 200, url: 'https://evil.example' }, null,
  ];
  for (const response of responses) {
    const client = createResendEmailClient({ ...CONFIG, fetchImpl: async () => response });
    await assert.rejects(client.send(MESSAGE), /EMAIL_RESPONSE_INVALID/);
  }
});

test('failed streaming receipt is cancelled; rate-limit retry guidance remains bounded', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(5000)); },
    cancel() { cancelled = true; },
  });
  const client = createResendEmailClient({ ...CONFIG, fetchImpl: async () => new Response(body,
    { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.send(MESSAGE), /EMAIL_RESPONSE_INVALID/);
  assert.equal(cancelled, true);
  for (const [header, expected] of [['99', 60_000], ['9999999999', null], ['invalid', null], ['0', 0]]) {
    const limited = createResendEmailClient({ ...CONFIG, fetchImpl: async () => new Response(null,
      { status: 429, headers: { 'retry-after': header } }) });
    await assert.rejects(limited.send(MESSAGE), (error) => error.retryAfterMs === expected);
  }
});

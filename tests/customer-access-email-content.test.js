import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createResendEmailClient } from '../src/integrations/resend-email-client.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const COMMON = { recipient: 'Invited+pilot@EXAMPLE.COM', tenantDisplayName: 'Example organisation', locale: 'en', deliveryId: UUID };
const CODE = { ...COMMON, code: '00123456', issuedAt: '2026-10-19T17:00:00.000Z', expiresAt: '2026-10-19T17:10:00.000Z' };
const CONFIG = { publicOrigin: 'https://customer.example.com', environment: 'int' };

test('DE and EN invitations contain only the fixed Customer origin and preserve the invited mailbox', () => {
  const content = createCustomerAccessEmailContent(CONFIG);
  for (const locale of ['de', 'en']) {
    const message = content.invitation({ ...COMMON, locale });
    assert.equal(Object.isFrozen(message), true);
    assert.deepEqual(Object.keys(message).sort(), ['deliveryId', 'recipient', 'subject', 'text']);
    assert.equal(message.recipient, 'Invited+pilot@example.com');
    assert.ok(message.text.includes(COMMON.tenantDisplayName));
    assert.equal(message.text.match(/https:\/\/\S+/g).join(), `${CONFIG.publicOrigin}/`);
    assert.match(message.subject, /^Conference Manager \[INT\]:/);
    assert.ok(message.text.includes(locale === 'de' ? 'eingeladen' : 'invited'));
    assert.equal(message.text.includes('tenant_admin'), false);
  }
  const production = createCustomerAccessEmailContent({ ...CONFIG, environment: 'prod' }).invitation(COMMON);
  assert.equal(production.subject, 'Conference Manager: Your invitation');
  assert.equal(production.text.includes('test environment'), false);
});

test('codes keep leading zeroes, stay out of subjects and disclose expiry with an explicit UTC timezone in both languages', () => {
  const content = createCustomerAccessEmailContent(CONFIG);
  for (const locale of ['de', 'en']) {
    const message = content.signInCode({ ...CODE, locale });
    assert.equal(message.subject.includes(CODE.code), false);
    assert.ok(message.text.includes(`\n${CODE.code}\n`));
    assert.match(message.text, /UTC/);
    assert.ok(message.text.includes(locale === 'de' ? '19. Oktober 2026' : '19 October 2026'));
    assert.ok(message.text.includes(locale === 'de' ? 'Teile ihn mit niemandem' : 'Do not share it with anyone'));
    assert.ok(message.text.includes(locale === 'de' ? 'im Browser' : 'in the browser'));
    assert.equal(message.text.includes('https://'), false);
  }
});

test('templates reject unknown locale, authority fields, malformed recipients and injected display labels', () => {
  const content = createCustomerAccessEmailContent(CONFIG);
  for (const input of [null, [], { ...COMMON, locale: 'fr' }, { ...COMMON, locale: '__proto__' },
    { ...COMMON, tenantId: UUID }, { ...COMMON, url: 'https://evil.example' }, { ...COMMON, role: 'tenant_admin' },
    { ...COMMON, recipient: 'a@example.com\r\nBcc: b@example.com' }, { ...COMMON, deliveryId: 'invalid' },
    ...['', ' x ', 'x'.repeat(161), 'x\nGo to another site', 'x\u2028other', 'x\u202eright'].map(
      (tenantDisplayName) => ({ ...COMMON, tenantDisplayName }))]) {
    assert.throws(() => content.invitation(input), /ACCESS_EMAIL_INPUT_INVALID/);
  }
});

test('codes reject unbounded lifetime, timestamps, malformed values and untrusted message fields', () => {
  const content = createCustomerAccessEmailContent(CONFIG);
  for (const change of [{ code: '1234567' }, { code: 12345678 }, { code: '12345678\n' },
    { expiresAt: '2026-10-19T16:59:59.000Z' }, { expiresAt: '2026-10-19T17:16:00.000Z' },
    { expiresAt: '2026-10-19T17:01:00.000Z' }, { expiresAt: '2026-10-19T17:10:00Z' },
    { issuedAt: 'invalid' }, { from: 'attacker@example.com' }]) {
    assert.throws(() => content.signInCode({ ...CODE, ...change }), /ACCESS_EMAIL_INPUT_INVALID/);
  }
  for (const publicOrigin of ['http://customer.example.com', 'https://customer.example.com/',
    'https://customer.example.com/path', 'https://customer.example.com?next=evil',
    'https://customer.example.com#evil', 'https://user:secret@customer.example.com', undefined, {}]) {
    assert.throws(() => createCustomerAccessEmailContent({ ...CONFIG, publicOrigin }), /ACCESS_EMAIL_CONFIGURATION_INVALID/);
  }
  assert.throws(() => createCustomerAccessEmailContent({ ...CONFIG, environment: 'demo' }), /ACCESS_EMAIL_CONFIGURATION_INVALID/);
});

test('rendered messages match the bounded transport contract without triggering a real send', async () => {
  let attempts = 0;
  const client = createResendEmailClient({ apiKey: 're_synthetic_test_key_0000000001', sender: 'support@example.com',
    environment: 'int', fetchImpl: async (url, request) => {
      attempts += 1;
      assert.equal(url, 'https://api.resend.com/emails');
      const body = JSON.parse(request.body);
      assert.equal(body.html, undefined);
      assert.equal(body.to.length, 1);
      assert.ok(body.text.includes('Example organisation'));
      return Response.json({ id: UUID });
    } });
  const content = createCustomerAccessEmailContent(CONFIG);
  assert.equal(attempts, 0);
  for (const locale of ['de', 'en']) {
    assert.equal((await client.send(content.invitation({ ...COMMON, locale }))).status, 'accepted');
    assert.equal((await client.send(content.signInCode({ ...CODE, locale }))).status, 'accepted');
  }
  assert.equal(attempts, 4);
});

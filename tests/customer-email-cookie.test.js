import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOMER_EMAIL_COOKIE_NAME as NAME, readCustomerEmailTransactionCookie as read,
  serializeCustomerEmailTransactionCookie as serialize, clearCustomerEmailTransactionCookie as clear,
} from '../src/identity/customer-email-cookie.js';

const challengeId = 'e0000000-0000-4000-8000-000000000001', browserToken = Buffer.alloc(32,1).toString('base64url');
const value = `${challengeId}.${browserToken}`;

test('email pending cookie is HTTPS-only, HttpOnly, Strict, narrowly scoped and bounded with no broad Domain', () => {
  const cookie = serialize({ challengeId,browserToken },{ maxAgeSeconds: 600 });
  assert.equal(cookie,`${NAME}=${value}; Path=/api/v1/auth/email; HttpOnly; SameSite=Strict; Secure; Max-Age=600`);
  assert.doesNotMatch(cookie,/Domain=|cm_session|cm_platform/);
  assert.deepEqual(read({ cookie: cookie.split(';')[0] }),{ challengeId,browserToken });
  assert.equal(Object.isFrozen(read({ cookie: cookie.split(';')[0] })),true);
  assert.equal(clear(),`${NAME}=; Path=/api/v1/auth/email; HttpOnly; SameSite=Strict; Secure; Max-Age=0; `
    +'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
});

test('other identity cookies, malformed, duplicate, encoded and noncanonical email credentials never authenticate', () => {
  const canonical = browserToken, alias = canonical.slice(0,-1)+String.fromCharCode(canonical.charCodeAt(canonical.length-1)+1);
  for (const cookie of [undefined,[],`${NAME}=`,`${NAME}=short`,`${NAME}=${value}; ${NAME}=${value}`,
    `${NAME}=invalid; ${NAME}=${value}`,`${NAME}=${value}; ${NAME}=invalid`,`${NAME}=${value}.extra`,
    `${NAME}=${challengeId.toUpperCase()}.${browserToken}`,`${NAME}=${challengeId}.${alias}`,`${NAME}=${value}%3Bother`,
    `cm_session=${value}; cm_platform_session=${value}`,`${NAME}=${value}; ${'x'.repeat(8192)}`]) {
    assert.equal(read({ cookie }),null);
  }
  assert.deepEqual(read({ cookie: `unrelated=value; ${NAME}=${value}; another=value` }),{ challengeId,browserToken });
});

test('cookie construction rejects unsafe identifiers, lifetimes, injection and attempts to serialize a cleared login credential', () => {
  for (const maxAgeSeconds of [undefined,0,-1,901,'600',1.5]) {
    assert.throws(() => serialize({ challengeId,browserToken },{ maxAgeSeconds }),/INVALID/);
  }
  for (const entry of [{ challengeId: 'invalid',browserToken },{ challengeId,browserToken: `${browserToken}\r\nother` },
    { challengeId,browserToken: `${browserToken}=` }]) assert.throws(() => serialize(entry,{ maxAgeSeconds: 600 }),/INVALID/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlatformMicrosoftCallbackQuery } from '../src/platform/http/microsoft-callback-query.js';

const state = 'S'.repeat(43);
const base = `https://platform.example.com/callback?state=${state}&code=synthetic-code`;
const parse = suffix => parsePlatformMicrosoftCallbackQuery(new URL(base + suffix));

test('Microsoft SDK success metadata is optional, bounded and discarded before authentication', () => {
  const expected = { state, code: 'synthetic-code', providerError: null };
  for (const suffix of ['', '&client_info=eyJ1aWQiOiJzeW50aGV0aWMifQ',
    '&session_state=11111111-1111-4111-8111-111111111111',
    `&client_info=${'A'.repeat(2048)}&session_state=${'B'.repeat(256)}`]) {
    const result = parse(suffix);
    assert.deepEqual(result, expected);
    assert.equal(Object.isFrozen(result), true);
  }
});

test('metadata cannot relax duplicate, unknown-field, size or authority validation', () => {
  for (const suffix of ['&client_info=', '&session_state=', '&client_info=%0A', '&session_state=%3Cscript%3E',
    '&client_info=A&client_info=B', '&session_state=A&session_state=B',
    `&client_info=${'A'.repeat(2049)}`, `&session_state=${'B'.repeat(257)}`,
    '&client_info=A&tenantId=attacker', '&client_info=A&state=other', '&session_state=A&code=other',
    '&client_info=A&error=access_denied', '&constructor=A', '&__proto__=A']) {
    assert.throws(() => parse(suffix), error => error.statusCode === 400 && error.code === 'PLATFORM_VALIDATION_FAILED');
  }
});

test('provider cancellation retains its exact contract without success metadata', () => {
  const url = new URL(`https://platform.example.com/callback?state=${state}&error=access_denied`);
  assert.deepEqual(parsePlatformMicrosoftCallbackQuery(url), { state, code: null, providerError: 'access_denied' });
  url.searchParams.set('client_info', 'A');
  assert.throws(() => parsePlatformMicrosoftCallbackQuery(url), /PLATFORM_VALIDATION_FAILED/);
});

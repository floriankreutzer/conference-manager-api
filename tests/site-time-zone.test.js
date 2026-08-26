import assert from 'node:assert/strict';
import test from 'node:test';
import { isIanaTimeZone } from '../src/domain/site-time-zone.js';

test('Site time zones require bounded IANA database identifiers', () => {
  for (const value of ['Europe/Berlin', 'America/New_York', 'Etc/UTC', 'UTC', 'GMT']) {
    assert.equal(isIanaTimeZone(value), true, value);
  }
  for (const value of [
    null,
    '',
    'Europe/Berlin ',
    'Europe//Berlin',
    'Europe/Not_A_Zone',
    `Europe/${'x'.repeat(64)}`,
  ]) {
    assert.equal(isIanaTimeZone(value), false, String(value));
  }
});

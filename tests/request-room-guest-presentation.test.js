import assert from 'node:assert/strict';
import test from 'node:test';
import { publicGuestRoomFields } from '../src/domain/request-room-guest-presentation.js';

test('guest Room projection exposes only bounded address and accessibility presentation', () => {
  assert.deepEqual(publicGuestRoomFields({
    roomDetails: { accessibility: ['Step-free access', 'Hearing loop'], equipment: ['Display'] },
    siteDetails: {
      address: { line1: 'Main Street 1', line2: null, postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
      providerId: 'secret',
    },
  }), {
    accessibility: ['Step-free access', 'Hearing loop'],
    address: { line1: 'Main Street 1', line2: null, postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
  });
});

test('guest Room projection fails closed for malformed public presentation and never forwards secrets', () => {
  assert.deepEqual(publicGuestRoomFields({
    roomDetails: { accessibility: ['<unsafe>'], wifiPassword: 'secret' },
    siteDetails: { address: { line1: 'A', line2: null, postalCode: '1', city: 'B', countryCode: 'DE', token: 'secret' } },
  }), { accessibility: [], address: null });
  assert.doesNotMatch(JSON.stringify(publicGuestRoomFields({
    roomDetails: { wifiPassword: 'secret' }, siteDetails: { providerId: 'secret' },
  })), /secret|wifi|provider/i);
});

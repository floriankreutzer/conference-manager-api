import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePublicRoomGuestValues,
  normalizePublicSiteGuestValues,
} from '../src/domain/public-guest-values.js';

test('public Guest values have finite states and no credential-bearing prose', () => {
  assert.deepEqual(normalizePublicSiteGuestValues({
    publicTransport: 'available', parking: 'not_available', arrival: 'reception',
    accessibilityFeatures: ['lift', 'step_free_entry'],
  }), {
    publicTransport: 'available', parking: 'not_available', arrival: 'reception',
    accessibilityFeatures: ['lift', 'step_free_entry'],
  });
  assert.deepEqual(normalizePublicRoomGuestValues({
    floorNumber: -1, accessibilityFeatures: ['accessible_toilet'],
  }), { floorNumber: -1, accessibilityFeatures: ['accessible_toilet'] });
  assert.equal(normalizePublicSiteGuestValues(null), null);
  assert.equal(normalizePublicRoomGuestValues(null), null);
  assert.throws(() => normalizePublicSiteGuestValues({
    publicTransport: 'Bus 42, door combination 1234', parking: 'available',
    arrival: 'reception', accessibilityFeatures: [],
  }), /PUBLIC_GUEST_VALUES_INVALID/);
  assert.throws(() => normalizePublicRoomGuestValues({
    floorNumber: 2, accessibilityFeatures: ['lift', 'lift'],
  }), /PUBLIC_GUEST_VALUES_INVALID/);
  assert.throws(() => normalizePublicRoomGuestValues({
    floorNumber: 2, accessibilityFeatures: [], doorCode: '1234',
  }), /PUBLIC_GUEST_VALUES_INVALID/);
});

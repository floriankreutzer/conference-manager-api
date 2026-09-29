import assert from 'node:assert/strict';
import test from 'node:test';
import { publicApplicationRoom } from '../src/domain/application-room-presentation.js';

function row(details = {}) {
  return {
    id: 'room-a',
    siteId: 'site-a',
    name: 'Room A',
    capacity: 12,
    active: true,
    price: { amountMinor: 2500, currency: 'EUR' },
    details,
  };
}

test('application Room projection exposes only bounded managed presentation fields', () => {
  assert.deepEqual(publicApplicationRoom(row({
    equipment: ['Display', 'HDMI <-> USB-C adapter'],
    floorplanAssetId: 'floorplan-room-a',
    mediaAssetIds: ['room-a-front', 'room-a-accessible-entry'],
    serviceIds: ['internal-service'],
  })), {
    id: 'room-a',
    siteId: 'site-a',
    name: 'Room A',
    capacity: 12,
    active: true,
    price: { amountMinor: 2500, currency: 'EUR' },
    equipment: ['Display', 'HDMI <-> USB-C adapter'],
    floorplanAssetId: 'floorplan-room-a',
    mediaAssetIds: ['room-a-front', 'room-a-accessible-entry'],
  });
});

test('application Room projection fails presentation metadata to deterministic empty fallbacks', () => {
  assert.deepEqual(publicApplicationRoom(row({
    equipment: ['unsafe\u0000label'],
    floorplanAssetId: 'https://attacker.invalid/room.png',
    mediaAssetIds: ['safe', '../private'],
  })), {
    id: 'room-a',
    siteId: 'site-a',
    name: 'Room A',
    capacity: 12,
    active: true,
    price: { amountMinor: 2500, currency: 'EUR' },
    equipment: [],
    floorplanAssetId: null,
    mediaAssetIds: [],
  });
  assert.deepEqual(publicApplicationRoom(row({ providerId: 'secret-provider-object' })), {
    id: 'room-a',
    siteId: 'site-a',
    name: 'Room A',
    capacity: 12,
    active: true,
    price: { amountMinor: 2500, currency: 'EUR' },
    equipment: [],
    floorplanAssetId: null,
    mediaAssetIds: [],
  });
});

test('application Room projection includes bounded descriptions without exposing unrelated details', () => {
  const text = 'Room with daylight and flexible seating';
  const projected = publicApplicationRoom(row({ description: text }));
  assert.equal(projected.description, text);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.hasOwn(publicApplicationRoom(row()), 'description'), false);
  for (const invalid of [null, '', ' padded ', 'x'.repeat(1001), 'unsafe\u0000text', 7, {}]) {
    assert.equal(publicApplicationRoom(row({ description: invalid })).description, null);
  }
  assert.equal(publicApplicationRoom(row({ description: 'x'.repeat(1000) })).description.length, 1000);
});

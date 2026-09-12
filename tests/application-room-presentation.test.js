import assert from 'node:assert/strict';
import test from 'node:test';
import { publicApplicationRoom } from '../src/domain/application-room-presentation.js';

function row(details = {}) {
  return {
    id: 'room-a',
    site_id: 'site-a',
    name: 'Room A',
    capacity: 12,
    active: true,
    price_minor: '2500',
    currency: 'EUR',
    details,
  };
}

test('application Room projection exposes only bounded managed presentation fields', () => {
  assert.deepEqual(publicApplicationRoom(row({
    equipment: ['Display', 'Whiteboard'],
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
    equipment: ['Display', 'Whiteboard'],
    floorplanAssetId: 'floorplan-room-a',
    mediaAssetIds: ['room-a-front', 'room-a-accessible-entry'],
  });
});

test('application Room projection fails presentation metadata to deterministic empty fallbacks', () => {
  assert.deepEqual(publicApplicationRoom(row({
    equipment: ['<script>'],
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

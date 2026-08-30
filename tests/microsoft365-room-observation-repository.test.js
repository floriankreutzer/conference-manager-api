import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPostgresMicrosoft365RoomObservationRepository,
} from '../src/persistence/postgres/microsoft365-room-observation-repository.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';

function providerRoom(index) {
  return Object.freeze({
    externalRoomId: `room-${index}`,
    displayName: `Room ${index}`,
    resourceAddress: `room-${index}@example.invalid`,
    capacity: 8,
  });
}

function poolProbe() {
  const upserts = [];
  const client = {
    async query(query) {
      if (typeof query === 'string') return { rowCount: 0, rows: [] };
      if (query.name === 'microsoft365-room-observation-authority') {
        return { rowCount: 1, rows: [{}] };
      }
      if (query.name === 'microsoft365-room-observation-upsert') {
        upserts.push(query.values);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`UNEXPECTED_QUERY:${query.name}`);
    },
    release() {},
  };
  return {
    upserts,
    pool: { query: (...args) => client.query(...args), connect: async () => client },
  };
}

test('room observations consume the canonical provider discovery DTO', async () => {
  const probe = poolProbe();
  const repository = createPostgresMicrosoft365RoomObservationRepository(probe.pool);
  assert.equal(await repository.recordDiscovery({
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    connectionVersion: 3,
    rooms: [providerRoom(1)],
  }), true);
  assert.deepEqual(probe.upserts[0].slice(2, 7), [
    'room-1',
    'room-1@example.invalid',
    'Room 1',
    8,
    'active',
  ]);
});

test('room observations preserve the provider collection bound of 1,000 rooms', async () => {
  const probe = poolProbe();
  const repository = createPostgresMicrosoft365RoomObservationRepository(probe.pool);
  const rooms = Array.from({ length: 1_000 }, (_, index) => providerRoom(index));
  assert.equal(await repository.recordDiscovery({
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    connectionVersion: 3,
    rooms,
  }), true);
  assert.equal(probe.upserts.length, 1_000);
  await assert.rejects(
    repository.recordDiscovery({
      tenantId: TENANT_ID,
      integrationId: INTEGRATION_ID,
      connectionVersion: 3,
      rooms: [...rooms, providerRoom(1_000)],
    }),
    { message: 'MICROSOFT365_ROOM_OBSERVATION_INVALID' },
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantLocationRepository } from '../src/persistence/postgres/tenant-location-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = '42111111-1111-4111-8111-111111111111';
const TENANT_B = '42222222-2222-4222-8222-222222222222';
const USER = '42333333-3333-4333-8333-333333333333';
const SITE = Object.freeze({ publicTransport: 'available', parking: 'not_available',
  arrival: 'reception', accessibilityFeatures: ['step_free_entry'] });
const ROOM = Object.freeze({ floorNumber: 2, accessibilityFeatures: ['lift'] });

test('structured Guest values are tenant-owned, revisioned, legacy-concealed, and rollback-safe', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Structured Guest','active')", [tenantId]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Editor')", [tenantId, USER]);
    await pool.query(`INSERT INTO sites(tenant_id,id,name,active,time_zone,details)
      VALUES($1,'campus','Campus',true,'Europe/Berlin','{"address":null}'::jsonb)`, [tenantId]);
    await pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity,active,details)
      VALUES($1,'meeting','campus','Meeting room',12,true,'{}'::jsonb)`, [tenantId]);
  }
  const repository = createPostgresTenantLocationRepository(pool, {
    auditRepository: { appendWithClient: async () => ({ id: 'audit-record' }) },
  });
  const initial = await repository.current(TENANT_A, { schemaVersion: 3 });
  assert.equal(initial.configuration.sites[0].guestPublicValues, null);
  assert.equal(initial.configuration.rooms[0].guestPublicValues, null);
  const configuration = {
    sites: initial.configuration.sites.map((site) => ({ ...site, guestPublicValues: SITE })),
    rooms: initial.configuration.rooms.map((room) => ({ ...room, guestPublicValues: ROOM })),
  };
  const change = async (values, expectedRevision, schemaVersion = 3) => repository.update({
    tenantId: TENANT_A, expectedRevision, nextRevision: expectedRevision + 1,
    configuration: values, schemaVersion, changedAt: new Date(), actorUserId: USER,
    auditEvent: {}, assertAuthorizedTransition: () => true,
  });
  await change(configuration, 1);
  const updated = await repository.current(TENANT_A, { schemaVersion: 3 });
  assert.deepEqual(updated.configuration.sites[0].guestPublicValues, SITE);
  assert.deepEqual(updated.configuration.rooms[0].guestPublicValues, ROOM);
  assert.equal((await repository.current(TENANT_B, { schemaVersion: 3 })).configuration.sites[0].guestPublicValues, null);
  for (const version of [1, 2]) {
    const prior = await repository.current(TENANT_A, { schemaVersion: version });
    assert.equal(Object.hasOwn(prior.configuration.sites[0], 'guestPublicValues'), false);
    assert.equal(Object.hasOwn(prior.configuration.rooms[0], 'guestPublicValues'), false);
  }
  const legacy = await repository.current(TENANT_A);
  await change(legacy.configuration, 2, 1);
  assert.deepEqual((await repository.current(TENANT_A, { schemaVersion: 3 })).configuration.rooms[0].guestPublicValues, ROOM);
  const restored = await repository.rollback({
    tenantId: TENANT_A, expectedRevision: 3, nextRevision: 4, sourceRevision: 1,
    schemaVersion: 3, changedAt: new Date(), actorUserId: USER,
    auditEvent: {}, assertAuthorizedTransition: () => true,
  });
  assert.equal(restored.configuration.rooms[0].guestPublicValues, null);
  assert.deepEqual((await repository.revision(TENANT_A, 2, { schemaVersion: 3 }))
    .configuration.rooms[0].guestPublicValues, ROOM);
  assert.deepEqual((await repository.current(TENANT_B, { schemaVersion: 3 }))
    .configuration.rooms[0].guestPublicValues, null);
});

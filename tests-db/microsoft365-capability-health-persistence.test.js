import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import {
  createPostgresMicrosoft365CapabilityHealthRepository,
} from '../src/persistence/postgres/microsoft365-capability-health-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest, rollbackToVersion } from '../scripts/db-migrations.mjs';

const TENANT_A = '91919191-9191-4919-8919-919191919191';
const TENANT_B = '92929292-9292-4929-8929-929292929292';
const INTEGRATION_A = '93939393-9393-4939-8939-939393939393';
const INTEGRATION_B = '94949494-9494-4949-8949-949494949494';
const PROVIDER_A = '95959595-9595-4959-8959-959595959595';
const PROVIDER_B = '96969696-9696-4969-8969-969696969696';
const TENANT_IDS = [TENANT_A, TENANT_B];
const VERIFIED_AT = new Date('2026-08-25T17:00:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seed(pool, tenantId, integrationId, providerReference) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Health ${tenantId.slice(0, 4)}`, 'active'],
  );
  await pool.query(
    `INSERT INTO integrations (
      tenant_id, id, provider, provider_reference, status, connection_version,
      last_verified_at, places_permission_status, calendars_permission_status,
      created_at, updated_at
    ) VALUES (
      $1, $2, 'microsoft365', $3, 'connected', 1,
      $4, 'granted', 'granted', $4, $4
    )`,
    [tenantId, integrationId, providerReference, VERIFIED_AT],
  );
}

test('Microsoft capability health is tenant-scoped, preserves last success and rolls back fail-closed', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await pool.query(
      'DELETE FROM microsoft365_capability_health WHERE tenant_id = ANY($1::uuid[])',
      [TENANT_IDS],
    );
    await pool.query(
      "DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[]) AND provider = 'microsoft365'",
      [TENANT_IDS],
    );
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await seed(pool, TENANT_A, INTEGRATION_A, PROVIDER_A);
  await seed(pool, TENANT_B, INTEGRATION_B, PROVIDER_B);
  const repository = createPostgresMicrosoft365CapabilityHealthRepository(pool);
  const successAt = new Date('2026-08-25T18:00:00.000Z');
  const failureAt = new Date('2026-08-25T18:01:00.000Z');

  await repository.record({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    providerTenantReference: PROVIDER_A,
    capability: 'free_busy',
    status: 'healthy',
    checkedAt: successAt,
    successful: true,
  });
  await repository.record({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    providerTenantReference: PROVIDER_A,
    capability: 'free_busy',
    status: 'unavailable',
    reason: 'provider_unavailable',
    checkedAt: failureAt,
  });
  const [health] = await repository.listByTenantIdAndIntegrationId(TENANT_A, INTEGRATION_A);
  assert.equal(health.status, 'unavailable');
  assert.equal(health.lastSuccessAt, successAt.toISOString());
  assert.deepEqual(
    await repository.listByTenantIdAndIntegrationId(TENANT_B, INTEGRATION_B),
    [],
  );

  assert.equal(
    await repository.record({
      tenantId: TENANT_A,
      integrationId: INTEGRATION_B,
      connectionVersion: 1,
      providerTenantReference: PROVIDER_B,
      capability: 'places',
      status: 'healthy',
      checkedAt: successAt,
      successful: true,
    }),
    null,
  );
  await pool.query(
    `UPDATE integrations
     SET provider_reference = $3, connection_version = 2
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, INTEGRATION_A, PROVIDER_B],
  );
  assert.equal(await repository.record({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    providerTenantReference: PROVIDER_A,
    capability: 'places',
    status: 'healthy',
    checkedAt: failureAt,
    successful: true,
  }), null);
  assert.equal(await rollbackToVersion(pool, 15), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await assert.rejects(rollbackLatest(pool), (error) => error.code === '55000');

  await pool.query('DELETE FROM microsoft365_capability_health WHERE tenant_id = $1', [TENANT_A]);
  assert.equal(await rollbackLatest(pool), true);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDatabaseConfig } from '../src/config.js';
import {
  CURRENT_SCHEMA_VERSION,
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const ROLE_SUFFIX = String(process.pid);
const ROLES = Object.freeze({
  runtime: `cm_attribution_runtime_${ROLE_SUFFIX}`,
  reset: `cm_attribution_reset_${ROLE_SUFFIX}`,
});
const ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const TENANT_ID = '38000000-0000-4000-8000-000000000001';
const USER_ID = '38000000-0000-4000-8000-000000000002';
const REQUEST_ID = 'attribution-privilege-probe';
const CREATED_AT = '2026-09-19T08:00:00.000Z';
const UPDATED_AT = '2026-09-19T09:00:00.000Z';
const STARTS_AT = '2026-09-20T08:00:00.000Z';
const ENDS_AT = '2026-09-20T09:00:00.000Z';
const PROTECTED_FUNCTIONS = Object.freeze([
  'mark_request_attribution_used()',
  'preserve_requester_attribution()',
  'capture_request_revision_attribution()',
  'preserve_booking_change_attribution()',
]);

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function identifier(value) {
  if (!ROLE_PATTERN.test(value)) throw new TypeError('ATTRIBUTION_TEST_ROLE_INVALID');
  return `"${value}"`;
}

async function createRoles(pool) {
  for (const role of Object.values(ROLES)) {
    await pool.query(`CREATE ROLE ${identifier(role)} NOLOGIN`);
  }
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE public.requests TO ${identifier(ROLES.runtime)}`,
  );
  await pool.query(
    `GRANT SELECT ON TABLE public.request_revisions TO ${identifier(ROLES.runtime)}`,
  );
}

async function dropRoles(pool) {
  for (const role of Object.values(ROLES).reverse()) {
    await pool.query(`DROP OWNED BY ${identifier(role)}`);
    await pool.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
  }
}

async function queryAsRole(pool, role, query) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${identifier(role)}`);
    const result = await client.query(query);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original privilege or integrity failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function seedAuthority(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Attribution privilege tenant', 'active', $2, $2)`,
    [TENANT_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at)
     VALUES ($1, $2, 'Restricted runtime user', $3, $3)`,
    [TENANT_ID, USER_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO sites (tenant_id, id, name, time_zone, created_at, updated_at)
     VALUES ($1, 'site-a', 'Attribution privilege site', 'Europe/Berlin', $2, $2)`,
    [TENANT_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO rooms (tenant_id, id, site_id, name, capacity, created_at, updated_at)
     VALUES ($1, 'room-a', 'site-a', 'Attribution privilege room', 10, $2, $2)`,
    [TENANT_ID, CREATED_AT],
  );
}

async function protectedFunctionState(pool) {
  const result = await pool.query(`
    SELECT
      proname,
      prosecdef,
      proconfig,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_execute
    FROM pg_proc AS proc
    WHERE proc.oid IN (
      'public.mark_request_attribution_used()'::regprocedure,
      'public.preserve_requester_attribution()'::regprocedure,
      'public.capture_request_revision_attribution()'::regprocedure,
      'public.preserve_booking_change_attribution()'::regprocedure
    )
    ORDER BY proname
  `);
  return result.rows;
}

async function assertDirectCallsDenied(pool, role) {
  for (const functionName of PROTECTED_FUNCTIONS) {
    await assert.rejects(
      queryAsRole(pool, role, `SELECT public.${functionName}`),
      (error) => error?.code === '42501',
    );
  }
}

test('migration 038 confines Request attribution SECURITY DEFINER execution to triggers', async (t) => {
  assert.equal(CURRENT_SCHEMA_VERSION, 42);
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    try {
      await migrateUp(pool);
    } finally {
      try {
        await dropRoles(pool);
      } finally {
        await pool.end();
      }
    }
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await seedAuthority(pool);
  await createRoles(pool);

  assert.deepEqual(await protectedFunctionState(pool), [
    {
      proname: 'capture_request_revision_attribution',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog'],
      public_execute: false,
    },
    {
      proname: 'mark_request_attribution_used',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog'],
      public_execute: false,
    },
    {
      proname: 'preserve_booking_change_attribution',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog'],
      public_execute: false,
    },
    {
      proname: 'preserve_requester_attribution',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog'],
      public_execute: false,
    },
  ]);
  await assertDirectCallsDenied(pool, ROLES.runtime);
  await assertDirectCallsDenied(pool, ROLES.reset);

  await queryAsRole(pool, ROLES.runtime, {
    text: `
      INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
        internal_participants, external_participants, status_changed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 'room-a', 'Submitted', $4, $5, 1, 0, $6, $6, $6)
    `,
    values: [TENANT_ID, REQUEST_ID, USER_ID, STARTS_AT, ENDS_AT, CREATED_AT],
  });
  await queryAsRole(pool, ROLES.runtime, {
    text: 'UPDATE requests SET updated_at = $3 WHERE tenant_id = $1 AND id = $2',
    values: [TENANT_ID, REQUEST_ID, UPDATED_AT],
  });
  const captured = await pool.query(
    `SELECT request.requester_display_name, state.post_cutover_evidence
     FROM requests AS request
     CROSS JOIN request_attribution_migration_state AS state
     WHERE request.tenant_id = $1 AND request.id = $2 AND state.singleton`,
    [TENANT_ID, REQUEST_ID],
  );
  assert.deepEqual(captured.rows, [{
    requester_display_name: 'Restricted runtime user',
    post_cutover_evidence: true,
  }]);

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 40), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 39), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 38), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 37), true);
  assert.deepEqual(await protectedFunctionState(pool), [
    {
      proname: 'capture_request_revision_attribution',
      prosecdef: false,
      proconfig: null,
      public_execute: true,
    },
    {
      proname: 'mark_request_attribution_used',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog'],
      public_execute: true,
    },
    {
      proname: 'preserve_booking_change_attribution',
      prosecdef: false,
      proconfig: null,
      public_execute: true,
    },
    {
      proname: 'preserve_requester_attribution',
      prosecdef: false,
      proconfig: null,
      public_execute: true,
    },
  ]);

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  for (const row of await protectedFunctionState(pool)) {
    assert.equal(row.public_execute, false);
    assert.equal(row.prosecdef, true);
    assert.deepEqual(row.proconfig, ['search_path=pg_catalog']);
  }
  await assertDirectCallsDenied(pool, ROLES.runtime);
  await assertDirectCallsDenied(pool, ROLES.reset);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createSessionService, SessionServiceError } from '../src/identity/session-service.js';
import {
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { createPostgresRoomAdapter } from '../src/persistence/postgres/room-adapter.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createTenantScopedRepository } from '../src/tenancy/tenant-scoped-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '44444444-4444-4444-8444-444444444444';
const SESSION_A = '55555555-5555-4555-8555-555555555555';
const SESSION_B = '66666666-6666-4666-8666-666666666666';
const SESSION_C = '77777777-7777-4777-8777-777777777777';
const TOKEN_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const TOKEN_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CSRF_KEY = 's'.repeat(32);

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seedTenant(pool, tenantId, userId, siteId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${siteId}`, 'active'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, `User ${siteId}`],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [tenantId, siteId, `Site ${siteId}`],
  );
}

async function seedRequest(pool, {
  tenantId,
  requestId,
  requesterUserId,
  status = REQUEST_STATUS.SUBMITTED,
}) {
  await pool.query(
    `INSERT INTO requests
      (tenant_id, id, requester_user_id, status, starts_at, ends_at, internal_participants, external_participants)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      requestId,
      requesterUserId,
      status,
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
      4,
      1,
    ],
  );
}

function identity(overrides = {}) {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    providerIdentity: { provider: 'test_oidc', reference: 'subject-a' },
    roles: ['employee'],
    permissions: ['request:read'],
    ...overrides,
  };
}

function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0];
}

test('PostgreSQL migration, tenant persistence, session, and authorization contract', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());

  await t.test('migration up is repeatable and schema readiness is versioned', async () => {
    await migrateUp(pool);
    await migrateUp(pool);
    assert.equal(await isPostgresSchemaReady(pool), true);
    const result = await pool.query('SELECT version, name FROM schema_migrations ORDER BY version');
    assert.deepEqual(result.rows, [
      { version: 1, name: 'core_tenant_schema' },
      { version: 2, name: 'secure_sessions' },
      { version: 3, name: 'request_authorization_workflow' },
    ]);
  });

  await t.test('tenant and room repositories isolate real records across tenants', async () => {
    await seedTenant(pool, TENANT_A, USER_A, 'site-a');
    await seedTenant(pool, TENANT_B, USER_B, 'site-b');

    const rooms = createTenantScopedRepository(createPostgresRoomAdapter(pool));
    const contextA = { tenantId: TENANT_A };
    const contextB = { tenantId: TENANT_B };

    await rooms.create(contextA, {
      id: 'shared-room',
      siteId: 'site-a',
      name: 'Alpha Room',
      capacity: 10,
      active: true,
    });
    await rooms.create(contextB, {
      id: 'shared-room',
      siteId: 'site-b',
      name: 'Beta Room',
      capacity: 20,
      active: true,
    });
    await rooms.create(contextA, {
      id: 'alpha-only-room',
      siteId: 'site-a',
      name: 'Alpha Only',
      capacity: 8,
      active: true,
    });

    assert.equal((await rooms.get(contextA, 'shared-room')).name, 'Alpha Room');
    assert.equal((await rooms.get(contextB, 'shared-room')).name, 'Beta Room');
    assert.equal(await rooms.get(contextB, 'alpha-only-room'), null);
    assert.equal(await rooms.update(contextB, 'alpha-only-room', { name: 'Stolen' }), null);
    assert.equal(await rooms.delete(contextB, 'alpha-only-room'), false);
    assert.equal((await rooms.get(contextA, 'alpha-only-room')).name, 'Alpha Only');

    const tenantRepository = createPostgresTenantRepository(pool);
    assert.equal((await tenantRepository.findById(TENANT_A)).displayName, 'Tenant site-a');
  });

  await t.test('database constraints prevent cross-tenant and malformed references', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT_A, 'cross-site', 'site-b', 'Cross Site', 5],
      ),
      (error) => error.code === '23503',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO requests
          (tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          TENANT_A,
          'cross-room-request',
          USER_A,
          'shared-room',
          REQUEST_STATUS.SUBMITTED,
          '2026-09-01T10:00:00.000Z',
          '2026-09-01T11:00:00.000Z',
        ],
      ).then(async () => {
        await pool.query(
          'UPDATE requests SET tenant_id = $1 WHERE tenant_id = $2 AND id = $3',
          [TENANT_B, TENANT_A, 'cross-room-request'],
        );
      }),
      (error) => error.code === '23503',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT_A, 'bad-capacity', 'site-a', 'Bad Capacity', 0],
      ),
      (error) => error.code === '23514',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO requests (tenant_id, id, requester_user_id, status, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          TENANT_A,
          'invalid-workflow-status',
          USER_A,
          'client-approved',
          '2026-09-01T10:00:00.000Z',
          '2026-09-01T11:00:00.000Z',
        ],
      ),
      (error) => error.code === '23514',
    );
  });

  await t.test('request repository is tenant-scoped and same IDs remain independent', async () => {
    await seedRequest(pool, { tenantId: TENANT_A, requestId: 'shared-request', requesterUserId: USER_A });
    await seedRequest(pool, { tenantId: TENANT_B, requestId: 'shared-request', requesterUserId: USER_B });
    await seedRequest(pool, { tenantId: TENANT_A, requestId: 'alpha-request', requesterUserId: USER_A });

    const requests = createPostgresRequestRepository(pool);
    assert.equal((await requests.findByTenantIdAndId(TENANT_A, 'shared-request')).requesterUserId, USER_A);
    assert.equal((await requests.findByTenantIdAndId(TENANT_B, 'shared-request')).requesterUserId, USER_B);
    assert.equal(await requests.findByTenantIdAndId(TENANT_B, 'alpha-request'), null);

    const changed = await requests.transitionByTenantIdAndId({
      tenantId: TENANT_A,
      requestId: 'shared-request',
      expectedStatus: REQUEST_STATUS.SUBMITTED,
      nextStatus: REQUEST_STATUS.IN_REVIEW,
      reason: null,
      changedAt: new Date('2026-08-24T10:00:00.000Z'),
    });
    assert.equal(changed.status, REQUEST_STATUS.IN_REVIEW);
    assert.equal((await requests.findByTenantIdAndId(TENANT_B, 'shared-request')).status, REQUEST_STATUS.SUBMITTED);
  });

  await t.test('request transitions reject stale concurrent state instead of silently overwriting', async () => {
    await seedRequest(pool, { tenantId: TENANT_A, requestId: 'race-request', requesterUserId: USER_A });
    const requests = createPostgresRequestRepository(pool);
    const transition = (nextStatus) => requests.transitionByTenantIdAndId({
      tenantId: TENANT_A,
      requestId: 'race-request',
      expectedStatus: REQUEST_STATUS.SUBMITTED,
      nextStatus,
      reason: null,
      changedAt: new Date('2026-08-24T10:05:00.000Z'),
    });
    const [first, second] = await Promise.all([
      transition(REQUEST_STATUS.IN_REVIEW),
      transition(REQUEST_STATUS.CONFIRMED),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const persisted = await requests.findByTenantIdAndId(TENANT_A, 'race-request');
    assert.ok([REQUEST_STATUS.IN_REVIEW, REQUEST_STATUS.CONFIRMED].includes(persisted.status));
  });

  await t.test('workflow reason constraints reject client-style status/reason combinations', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE requests
         SET status_reason = $3
         WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, 'alpha-request', 'Injected reason'],
      ),
      (error) => error.code === '23514',
    );
  });

  await t.test('concurrent duplicate writes are deterministic within one tenant', async () => {
    const insert = () => pool.query(
      `INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
       VALUES ($1, $2, $3, $4, $5)`,
      [TENANT_A, 'concurrent-room', 'site-a', 'Concurrent Room', 4],
    );
    const results = await Promise.allSettled([insert(), insert()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, '23505');
  });

  await t.test('failed transactions do not leave successful writes behind', async () => {
    await assert.rejects(
      withPostgresTransaction(pool, async (client) => {
        await client.query(
          'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
          [TENANT_A, 'rolled-back-site', 'Rolled Back'],
        );
        throw new Error('EXPECTED_FAILURE');
      }),
      /EXPECTED_FAILURE/,
    );
    const result = await pool.query(
      'SELECT count(*)::int AS count FROM sites WHERE tenant_id = $1 AND id = $2',
      [TENANT_A, 'rolled-back-site'],
    );
    assert.equal(result.rows[0].count, 0);
  });

  await t.test('session persistence stores only hashes and rejects cross-tenant identities', async () => {
    const repository = createPostgresSessionRepository(pool);
    const service = createSessionService({
      repository,
      publicOrigin: 'https://conference.example',
      csrfSecret: CSRF_KEY,
      clock: () => Date.parse('2026-08-24T06:00:00.000Z'),
      tokenFactory: () => TOKEN_A,
      idFactory: () => SESSION_A,
    });

    const issued = await service.issue(identity());
    const persisted = await pool.query(
      'SELECT token_hash, provider, provider_identity_reference FROM sessions WHERE id = $1',
      [SESSION_A],
    );
    assert.match(persisted.rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(persisted.rows[0].token_hash, TOKEN_A);
    assert.equal(persisted.rows[0].provider, 'test_oidc');
    assert.equal(persisted.rows[0].provider_identity_reference, 'subject-a');
    assert.doesNotMatch(JSON.stringify(persisted.rows[0]), new RegExp(TOKEN_A));

    const resolved = await service.resolvePrincipal({ headers: { cookie: cookiePair(issued.setCookie) } });
    assert.equal(resolved.userId, USER_A);
    assert.equal(resolved.tenantId, TENANT_A);
    assert.equal(await service.verifyCsrf({ headers: { 'x-csrf-token': issued.csrfToken } }, resolved), true);

    await assert.rejects(service.issue(identity({ tenantId: TENANT_B })), (error) => {
      return error instanceof SessionServiceError && error.code === 'IDENTITY_NOT_PROVISIONED';
    });
  });

  await t.test('expired and revoked sessions fail closed against PostgreSQL', async () => {
    let now = Date.parse('2026-08-24T07:00:00.000Z');
    const repository = createPostgresSessionRepository(pool);
    const service = createSessionService({
      repository,
      publicOrigin: 'https://conference.example',
      csrfSecret: CSRF_KEY,
      sessionTtlSeconds: 300,
      clock: () => now,
      tokenFactory: () => TOKEN_B,
      idFactory: () => SESSION_B,
    });

    const issued = await service.issue(identity());
    const request = { headers: { cookie: cookiePair(issued.setCookie) } };
    assert.ok(await service.resolvePrincipal(request));
    now += 301_000;
    assert.equal(await service.resolvePrincipal(request), null);

    now = Date.parse('2026-08-24T08:00:00.000Z');
    const revocationService = createSessionService({
      repository,
      publicOrigin: 'https://conference.example',
      csrfSecret: CSRF_KEY,
      sessionTtlSeconds: 300,
      clock: () => now,
      tokenFactory: () => TOKEN_C,
      idFactory: () => SESSION_C,
    });
    const revocable = await revocationService.issue(identity());
    const revocableRequest = { headers: { cookie: cookiePair(revocable.setCookie) } };
    assert.ok(await revocationService.resolvePrincipal(revocableRequest));
    assert.equal(await revocationService.revoke(revocable.principal), true);
    assert.equal(await revocationService.resolvePrincipal(revocableRequest), null);
  });

  await t.test('security-version change invalidates stale privileges and authorized rotation refreshes them', async () => {
    let now = Date.parse('2026-08-24T09:00:00.000Z');
    const repository = createPostgresSessionRepository(pool);
    const tokens = [
      'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
      'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    ];
    const ids = [
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999',
    ];
    const service = createSessionService({
      repository,
      publicOrigin: 'https://conference.example',
      csrfSecret: CSRF_KEY,
      clock: () => now,
      tokenFactory: () => tokens.shift(),
      idFactory: () => ids.shift(),
    });

    const original = await service.issue(identity());
    const originalRequest = { headers: { cookie: cookiePair(original.setCookie) } };
    assert.deepEqual((await service.resolvePrincipal(originalRequest)).roles, ['employee']);

    await pool.query(
      `UPDATE users
       SET security_version = security_version + 1
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, USER_A],
    );
    assert.equal(await service.resolvePrincipal(originalRequest), null);

    await assert.rejects(
      pool.query(
        `UPDATE users
         SET security_version = security_version - 1
         WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, USER_A],
      ),
      (error) => error.code === '23514',
    );

    now += 1_000;
    const rotated = await service.rotate(original.principal, identity({
      roles: ['conference_manager'],
      permissions: ['request:read', 'request:manage'],
    }));
    const rotatedRequest = { headers: { cookie: cookiePair(rotated.setCookie) } };
    const refreshed = await service.resolvePrincipal(rotatedRequest);
    assert.deepEqual(refreshed.roles, ['conference_manager']);
    assert.deepEqual(refreshed.permissions, ['request:read', 'request:manage']);
    assert.equal(refreshed.session.securityVersion, 2);
    assert.equal(await service.resolvePrincipal(originalRequest), null);
  });

  await t.test('request and session migrations remain independently reversible and reapplicable', async () => {
    assert.equal(await rollbackLatest(pool), true);
    assert.equal(await isPostgresSchemaReady(pool), false);
    let remaining = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(remaining.rows, [{ version: 1 }, { version: 2 }]);

    await migrateUp(pool);
    assert.equal(await isPostgresSchemaReady(pool), true);
    assert.equal(await rollbackLatest(pool), true);
    assert.equal(await rollbackLatest(pool), true);
    remaining = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(remaining.rows, [{ version: 1 }]);

    await migrateUp(pool);
    assert.equal(await isPostgresSchemaReady(pool), true);
  });
});

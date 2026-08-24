import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresOidcTransactionRepository } from '../src/persistence/postgres/oidc-transaction-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const STATE_HASH = 'a'.repeat(64);
const NONCE_HASH = 'b'.repeat(64);
const OTHER_STATE_HASH = 'c'.repeat(64);
const OTHER_NONCE_HASH = 'd'.repeat(64);
const INVITATION_ID = '81818181-8181-4818-8818-818181818181';
const TENANT_ID = '82828282-8282-4828-8828-828282828282';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM oidc_auth_transactions');
  await pool.query('DELETE FROM tenant_onboarding_invitations WHERE id = $1', [INVITATION_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

test('OIDC transaction persistence atomically consumes state exactly once', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await clean(pool);

  const repository = createPostgresOidcTransactionRepository(pool);
  const createdAt = new Date('2026-08-24T12:00:00.000Z');
  const expiresAt = new Date('2026-08-24T12:10:00.000Z');
  await repository.create({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    nonceHash: NONCE_HASH,
    createdAt,
    expiresAt,
  });

  const first = await repository.consume({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:01:00.000Z'),
  });
  assert.deepEqual(first, { nonceHash: NONCE_HASH, onboardingInvitationId: null });
  const replay = await repository.consume({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:01:01.000Z'),
  });
  assert.equal(replay, null);
});

test('trusted onboarding invitation context survives OIDC state storage and one-time consume', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  await clean(pool);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [TENANT_ID, 'OIDC Invitation Tenant', 'pending'],
  );
  await pool.query(
    `INSERT INTO tenant_onboarding_invitations
      (id, tenant_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      INVITATION_ID,
      TENANT_ID,
      'f'.repeat(64),
      '2026-08-24T12:00:00.000Z',
      '2026-08-25T12:00:00.000Z',
    ],
  );

  const repository = createPostgresOidcTransactionRepository(pool);
  await repository.create({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    nonceHash: NONCE_HASH,
    onboardingInvitationId: INVITATION_ID,
    createdAt: new Date('2026-08-24T12:00:00.000Z'),
    expiresAt: new Date('2026-08-24T12:10:00.000Z'),
  });
  const consumed = await repository.consume({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:01:00.000Z'),
  });
  assert.deepEqual(consumed, { nonceHash: NONCE_HASH, onboardingInvitationId: INVITATION_ID });
  await clean(pool);
});

test('concurrent callback consumers cannot both redeem the same OIDC state', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  await clean(pool);

  const repository = createPostgresOidcTransactionRepository(pool);
  await repository.create({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    nonceHash: NONCE_HASH,
    createdAt: new Date('2026-08-24T12:00:00.000Z'),
    expiresAt: new Date('2026-08-24T12:10:00.000Z'),
  });

  const consumedAt = new Date('2026-08-24T12:01:00.000Z');
  const results = await Promise.all([
    repository.consume({ provider: 'microsoft_entra', stateHash: STATE_HASH, consumedAt }),
    repository.consume({ provider: 'microsoft_entra', stateHash: STATE_HASH, consumedAt }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(results.find(Boolean), { nonceHash: NONCE_HASH, onboardingInvitationId: null });
});

test('OIDC transaction state is provider scoped', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  await clean(pool);

  const repository = createPostgresOidcTransactionRepository(pool);
  const createdAt = new Date('2026-08-24T12:00:00.000Z');
  const expiresAt = new Date('2026-08-24T12:10:00.000Z');
  await repository.create({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    nonceHash: NONCE_HASH,
    createdAt,
    expiresAt,
  });
  await repository.create({
    provider: 'test_oidc',
    stateHash: STATE_HASH,
    nonceHash: OTHER_NONCE_HASH,
    createdAt,
    expiresAt,
  });

  const microsoft = await repository.consume({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:01:00.000Z'),
  });
  assert.deepEqual(microsoft, { nonceHash: NONCE_HASH, onboardingInvitationId: null });
  const other = await repository.consume({
    provider: 'test_oidc',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:01:00.000Z'),
  });
  assert.deepEqual(other, { nonceHash: OTHER_NONCE_HASH, onboardingInvitationId: null });
});

test('expired OIDC state fails closed and is removed by bounded cleanup', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  await clean(pool);

  const repository = createPostgresOidcTransactionRepository(pool);
  await repository.create({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    nonceHash: NONCE_HASH,
    createdAt: new Date('2026-08-24T12:00:00.000Z'),
    expiresAt: new Date('2026-08-24T12:02:00.000Z'),
  });
  assert.equal(await repository.consume({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:02:00.000Z'),
  }), null);

  await repository.create({
    provider: 'microsoft_entra',
    stateHash: OTHER_STATE_HASH,
    nonceHash: NONCE_HASH,
    createdAt: new Date('2026-08-24T12:03:00.000Z'),
    expiresAt: new Date('2026-08-24T12:13:00.000Z'),
  });
  const result = await pool.query('SELECT state_hash FROM oidc_auth_transactions ORDER BY state_hash');
  assert.deepEqual(result.rows.map((row) => row.state_hash.trim()), [OTHER_STATE_HASH]);
  await clean(pool);
});

test('OIDC migration rolls back and reapplies without touching established session schema', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  await clean(pool);

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  assert.equal(await rollbackLatest(pool), true);
  const missing = await pool.query("SELECT to_regclass('public.oidc_auth_transactions') AS table_name");
  assert.equal(missing.rows[0].table_name, null);
  const sessions = await pool.query("SELECT to_regclass('public.sessions') AS table_name");
  assert.equal(sessions.rows[0].table_name, 'sessions');

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const restored = await pool.query("SELECT to_regclass('public.oidc_auth_transactions') AS table_name");
  assert.equal(restored.rows[0].table_name, 'oidc_auth_transactions');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresOidcTransactionRepository } from '../src/persistence/postgres/oidc-transaction-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const STATE_HASH = 'a'.repeat(64);
const NONCE_HASH = 'b'.repeat(64);
const OTHER_STATE_HASH = 'c'.repeat(64);

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

test('OIDC transaction persistence atomically consumes state exactly once', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await pool.query('DELETE FROM oidc_auth_transactions');

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
  assert.deepEqual(first, { nonceHash: NONCE_HASH });
  const replay = await repository.consume({
    provider: 'microsoft_entra',
    stateHash: STATE_HASH,
    consumedAt: new Date('2026-08-24T12:01:01.000Z'),
  });
  assert.equal(replay, null);
});

test('expired OIDC state fails closed and is removed by bounded cleanup', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());
  await migrateUp(pool);
  await pool.query('DELETE FROM oidc_auth_transactions');

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
  await pool.query('DELETE FROM oidc_auth_transactions');
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createCustomerComposition } from '../../src/customer-composition.js';
import { createLogger } from '../../src/logger.js';
import { createPostgresPersistence } from '../../src/persistence/postgres/index.js';
import { migrateUp } from '../../scripts/db-migrations.mjs';
import { createTargetLoadCalendar } from '../../scripts/support/target-load-calendar.mjs';
import { prepareBookingLoadMedia } from '../../scripts/support/target-load-media-fixtures.mjs';
import { seedBookingLoadFixtures } from '../../scripts/support/target-load-fixtures.mjs';
import { instrumentLoadPool } from './customer-load-fixtures.js';

// Disposable loopback fixture only. Never provisions or connects to a remote target.
export async function createBookingJourneyFixture(t) {
  const url = new URL(process.env.DATABASE_URL);
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), DATABASE_SSL: 'disable',
    RATE_LIMIT_MAX: '10000', PUBLIC_ORIGIN: 'http://127.0.0.1:3000', ENTRA_CLIENT_ID: randomUUID(),
    ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'), OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') }), port: 0 };
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  const objects = new Map(); let objectReads = 0; let objectBytes = 0;
  const storage = {
    async put(reference, bytes) {
      assert.ok(tenants.includes(reference.tenantId) && reference.kind === 'room' && objects.size < 10);
      objects.set(reference.key, Buffer.from(bytes)); return reference.key;
    },
    async get(reference) {
      assert.ok(tenants.includes(reference.tenantId) && objects.has(reference.key));
      objectReads += 1; const bytes = Buffer.from(objects.get(reference.key)); objectBytes += bytes.length; return bytes;
    },
    async remove() { throw new Error('LOAD_STORAGE_DELETE_FORBIDDEN'); },
  };
  const persistence = createPostgresPersistence(config, { mediaObjectStorage: storage });
  const counters = instrumentLoadPool(persistence.pool); let runtime;
  t.after(async () => { try { await runtime?.stop(); } finally { await persistence.close(); } });
  await migrateUp(persistence.pool);
  const postgresVersion = Number((await persistence.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(postgresVersion >= 180000 && postgresVersion < 190000);
  const { expectedRooms, bindings, managers, employees } = await seedBookingLoadFixtures(persistence.pool, tenants);
  const calendar = createTargetLoadCalendar(bindings);
  runtime = createCustomerComposition({ config, persistence: { ...persistence, close: async () => {} },
    microsoft365Client: calendar.client, logger: createLogger({ write() {} }) });
  const address = await runtime.start(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
  const { images, managerTokens, configurations } = await prepareBookingLoadMedia({
    runtime, config, persistence, tenants, managers, expectedRooms });
  return { config, persistence, tenants, managers, employees, managerTokens, calendar, configurations,
    images, expectedRooms, storage, counters, postgresVersion, objectCounters: () => ({ reads: objectReads, bytes: objectBytes }) };
}

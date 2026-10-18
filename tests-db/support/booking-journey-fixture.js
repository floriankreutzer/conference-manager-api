import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../src/config.js';
import { createCustomerComposition } from '../../src/customer-composition.js';
import { createApplicationCatalogContext } from '../../src/application/catalog-page.js';
import { createLogger } from '../../src/logger.js';
import { createPostgresPersistence } from '../../src/persistence/postgres/index.js';
import { migrateUp } from '../../scripts/db-migrations.mjs';
import { measureSessionReads } from '../../scripts/session-load-evidence.mjs';
import { createTargetLoadCalendar } from '../../scripts/support/target-load-calendar.mjs';
import { seedLoadSessions, instrumentLoadPool } from './customer-load-fixtures.js';

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
  const objects = new Map(); const assets = new Map(); let objectReads = 0; let objectBytes = 0;
  const storage = {
    async put(reference, bytes) {
      assert.ok(tenants.includes(reference.tenantId) && reference.kind === 'room' && objects.size < 10);
      objects.set(reference.key, Buffer.from(bytes)); assets.set(reference.assetId, Buffer.from(bytes)); return reference.key;
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
  await persistence.pool.query(`INSERT INTO tenants(id,display_name,status)
    SELECT id,'Synthetic journey fixture','active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO sites(tenant_id,id,name,time_zone)
    SELECT id,'site','Synthetic site','Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  const expectedRooms = tenants.map((tenantId, tenantIndex) => Array.from({ length: 10 }, (_, roomIndex) => ({
    id: roomIndex === 0 ? 'room' : `room-0${roomIndex}`, siteId: 'site', name: `Synthetic ${tenantIndex} room ${roomIndex}`,
    capacity: 20, active: true, price: { amountMinor: 1000 + tenantIndex * 100 + roomIndex, currency: 'EUR' },
    equipment: [], floorplanAssetId: null, mediaAssetIds: [],
  })));
  const rows = JSON.stringify(tenants.flatMap((tenantId, index) => expectedRooms[index].map(room => ({ tenantId, ...room }))));
  await persistence.pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
    SELECT "tenantId",id,'site',name,capacity FROM jsonb_to_recordset($1::jsonb)
    AS fixture("tenantId" uuid,id text,name text,capacity integer)`, [rows]);
  await persistence.pool.query(`INSERT INTO tenant_room_prices(tenant_id,room_id,price_minor,currency,created_at,updated_at)
    SELECT "tenantId",id,(price->>'amountMinor')::bigint,'EUR',transaction_timestamp(),transaction_timestamp()
    FROM jsonb_to_recordset($1::jsonb) AS fixture("tenantId" uuid,id text,price jsonb)`, [rows]);
  const bindings = new Map();
  for (let index = 0; index < tenants.length; index += 1) {
    const tenantId = tenants[index]; const integration = randomUUID(); const reference = randomUUID();
    const address = `room${index}@synthetic.invalid`; bindings.set(reference, { address });
    await persistence.pool.query(`INSERT INTO tenant_entitlements(tenant_id,capability_id,enabled)
      SELECT $1,id,true FROM unnest($2::text[]) id`,
    [tenantId, ['microsoft.directory', 'microsoft.calendar', 'microsoft.calendar.write']]);
    await persistence.pool.query(`INSERT INTO tenant_identity_bindings
      (id,tenant_id,provider,provider_tenant_reference,status,created_at,updated_at)
      VALUES($1,$2,'microsoft_entra',$3,'active',transaction_timestamp(),transaction_timestamp())`,
    [randomUUID(), tenantId, reference]);
    await persistence.pool.query(`INSERT INTO integrations
      (tenant_id,id,provider,provider_reference,status,connection_version,last_verified_at,
       places_permission_status,calendars_permission_status,created_at,updated_at)
      VALUES($1,$2,'microsoft365',$3,'connected',1,transaction_timestamp(),'granted','granted',
      transaction_timestamp(),transaction_timestamp())`, [tenantId, integration, reference]);
    await persistence.pool.query(`INSERT INTO microsoft365_room_mappings
      (tenant_id,room_id,integration_id,external_room_id,resource_address,provider_display_name,provider_capacity,
       last_seen_at,created_at,updated_at) VALUES($1,'room',$2,$3,$4,'Synthetic room',20,
       transaction_timestamp(),transaction_timestamp(),transaction_timestamp())`, [tenantId, integration, randomUUID(), address]);
  }
  const calendar = createTargetLoadCalendar(bindings); const managers = []; const employees = []; const managerTokens = [];
  await seedLoadSessions(persistence.pool, tenants, managers, 10, { roles: ['conference_manager'] });
  await seedLoadSessions(persistence.pool, tenants, employees, 1000, { roles: ['employee'] });
  runtime = createCustomerComposition({ config, persistence: { ...persistence, close: async () => {} },
    microsoft365Client: calendar.client, logger: createLogger({ write() {} }) });
  const address = await runtime.start(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
  await measureSessionReads({ origin: config.publicOrigin, cookies: managers.map(x => x.cookie), verify(body, index) {
    assert.equal(body.user.id, managers[index].userId); managerTokens[index] = body.csrfToken;
  } });
  const images = [];
  for (let index = 0; index < tenants.length; index += 1) {
    const encoded = await readFile(new URL(`../../src/demo/media/northwind-room-0${index % 3 + 1}.webp.b64`, import.meta.url), 'utf8');
    const response = await fetch(`${config.publicOrigin}/api/v1/tenant/rooms/room/media`, {
      method: 'POST', headers: { Cookie: managers[index].cookie, Origin: config.publicOrigin,
        'X-CSRF-Token': managerTokens[index], 'Content-Type': 'image/webp' }, body: Buffer.from(encoded, 'base64'),
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201); const { assetId } = await response.json();
    expectedRooms[index][0].mediaAssetIds = [assetId];
    await persistence.pool.query(`UPDATE rooms SET details=jsonb_build_object('mediaAssetIds',jsonb_build_array($2::text))
      WHERE tenant_id=$1 AND id='room'`, [tenants[index], assetId]);
    const bytes = assets.get(assetId);
    images[index] = { assetId, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const configurations = await Promise.all(tenants.map(async tenantId => {
    const page = await persistence.applicationRepository.loadCatalogPage({ tenantId, section: 'sites', limit: 1 });
    assert.equal(page.status, 'ready');
    return { revisions: page.configurationRevisions, context: createApplicationCatalogContext({
      revisions: page.configurationRevisions, policyVersionId: page.bookingPolicy.policyVersionId }) };
  }));
  return { config, persistence, tenants, managers, employees, managerTokens, calendar, configurations,
    images, expectedRooms, counters, postgresVersion, objectCounters: () => ({ reads: objectReads, bytes: objectBytes }) };
}

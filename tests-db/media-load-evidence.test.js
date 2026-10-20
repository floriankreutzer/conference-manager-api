import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureRoomMediaReads, measureSessionReads } from '../scripts/session-load-evidence.mjs';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { instrumentLoadPool, seedLoadSessions } from './support/customer-load-fixtures.js';

test('object-backed media measures full and conditional delivery without claiming saved provider reads', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), DATABASE_SSL: 'disable',
    RATE_LIMIT_MAX: '10000', PUBLIC_ORIGIN: 'http://127.0.0.1:3000', ENTRA_CLIENT_ID: randomUUID(),
    ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'), OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') }), port: 0 };
  const objects = new Map(); const assets = new Map();
  let reads = 0; let objectBytes = 0; let corrupt = false;
  const storage = {
    async put(reference, bytes) {
      assert.ok(objects.size < 10); objects.set(reference.key, Buffer.from(bytes));
      assets.set(reference.assetId, Buffer.from(bytes)); return reference.key;
    },
    async get(reference) {
      assert.ok(objects.has(reference.key)); reads += 1;
      const bytes = corrupt ? Buffer.from('corrupt') : Buffer.from(objects.get(reference.key));
      objectBytes += bytes.length; return bytes;
    },
    async remove() { throw new Error('LOAD_STORAGE_DELETE_FORBIDDEN'); },
  };
  const persistence = createPostgresPersistence(config, { mediaObjectStorage: storage });
  t.after(() => persistence.close());
  const counters = instrumentLoadPool(persistence.pool); await migrateUp(persistence.pool);
  const version = Number((await persistence.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 180000 && version < 190000);
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  await persistence.pool.query(`INSERT INTO tenants(id,display_name,status)
    SELECT id,'Synthetic media fixture','active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO sites(tenant_id,id,name,time_zone)
    SELECT id,'site','Synthetic site','Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
    SELECT id,'room','site','Synthetic room',20 FROM unnest($1::uuid[]) AS id`, [tenants]);
  const managers = []; const employees = []; const assetIds = [];
  await seedLoadSessions(persistence.pool, tenants, managers, 10, { roles: ['conference_manager'] });
  const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence, close: async () => {} } });
  t.after(() => runtime.stop());
  const address = await runtime.start(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
  const tokens = [];
  await measureSessionReads({ origin: config.publicOrigin, cookies: managers.map(x => x.cookie), verify(body, index) {
    assert.equal(body.user.id, managers[index].userId); tokens[index] = body.csrfToken;
  } });
  for (let index = 0; index < tenants.length; index += 1) {
    const encoded = await readFile(new URL(`../src/synthetic/media/northwind-room-0${index % 3 + 1}.webp.b64`, import.meta.url), 'utf8');
    const response = await fetch(`${config.publicOrigin}/api/v1/tenant/rooms/room/media`, {
      method: 'POST', headers: { Cookie: managers[index].cookie, Origin: config.publicOrigin,
        'X-CSRF-Token': tokens[index], 'Content-Type': 'image/webp' }, body: Buffer.from(encoded, 'base64'),
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201); const { assetId } = await response.json(); assetIds.push(assetId);
    await persistence.pool.query(`UPDATE rooms SET details=jsonb_build_object('mediaAssetIds',jsonb_build_array($2::text))
      WHERE tenant_id=$1 AND id='room'`, [tenants[index], assetId]);
  }
  assert.equal(objects.size, 10);
  const blobs = await persistence.pool.query('SELECT count(*)::int AS count FROM tenant_room_media_assets WHERE bytes IS NOT NULL');
  assert.equal(blobs.rows[0].count, 0);
  for (const target of [100, 1000]) {
    await seedLoadSessions(persistence.pool, tenants, employees, target, { roles: ['employee'] });
    const selected = employees.map(x => assetIds[tenants.indexOf(x.tenantId)]); const etags = [];
    const expectedBytes = selected.reduce((sum, id) => sum + assets.get(id).length, 0);
    const results = [];
    for (const conditional of [false, true]) {
      const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
      try { await Promise.all(clients.map(client => client.query('SELECT 1'))); }
      finally { clients.forEach(client => client.release()); }
      const before = counters(); const beforeReads = reads; const beforeBytes = objectBytes;
      const result = await measureRoomMediaReads({ origin: config.publicOrigin, cookies: employees.map(x => x.cookie),
        assetIds: selected, ...(conditional ? { etags } : {}), verify(body, index, metadata) {
          assert.equal(metadata.status, conditional ? 304 : 200);
          if (conditional) { assert.equal(body.length, 0); assert.equal(metadata.etag, etags[index]); }
          else { assert.deepEqual(body, assets.get(selected[index])); etags[index] = metadata.etag; }
        } });
      const after = counters();
      assert.ok(after.queries > before.queries && after.bytesRead > before.bytesRead && after.bytesWritten > before.bytesWritten);
      assert.equal(reads - beforeReads, target); assert.equal(objectBytes - beforeBytes, expectedBytes);
      assert.equal(result.payloadBytes, conditional ? 0 : expectedBytes);
      results.push({ phase: conditional ? 'conditional-304' : 'full-200', ...result,
        postgresProtocol: Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])),
        fixtureObjectReads: reads - beforeReads, fixtureObjectBytes: objectBytes - beforeBytes });
    }
    const beforeDenied = reads;
    for (const [cookie, assetId, expected] of [[null, assetIds[0], 401], [employees[0].cookie, assetIds[1], 404]]) {
      const response = await fetch(`${config.publicOrigin}/api/v1/tenant/rooms/room/media/${assetId}`, {
        headers: { ...(cookie ? { Cookie: cookie } : {}), 'If-None-Match': etags[0] },
        redirect: 'error', signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer(); assert.equal(response.status, expected);
    }
    assert.equal(reads, beforeDenied, 'Denied HTTP reads must not touch object storage');
    corrupt = true;
    const response = await fetch(`${config.publicOrigin}/api/v1/tenant/rooms/room/media/${assetIds[0]}`, {
      headers: { Cookie: employees[0].cookie, 'If-None-Match': etags[0] },
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'ROOM_MEDIA_UNAVAILABLE');
    corrupt = false;
    for (const tenantId of tenants) assert.equal(await persistence.auditRepository.verifyTenantChain(tenantId), true);
    for (const result of results) t.diagnostic(JSON.stringify({ schemaVersion: 1,
      environment: 'isolated-postgres18-loopback', workload: 'object-backed-room-media', fixtureUsers: target,
      managerFixtureUsers: 10, tenants: 10, poolMax: config.databasePoolMax,
      nodeVersion: process.version, postgresVersion: version, ...result,
      storage: 'in-process-object-port-fixture', providerEgressMeasured: false, productionCapacityProven: false,
      representativeMixedReplay: false, cacheMixApproved: false }));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { growTargetLoadPopulation } from '../scripts/support/target-load-growth.mjs';
import { targetLoadManifest } from './support/target-load-manifest.js';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';

async function fixture() {
  const manifest = await targetLoadManifest(); const env = { ...targetLoadSetupEnvironment(), LOAD_FIXTURE_USERS: '1000' };
  let mutations = 0; let closed = 0; const queries = [];
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT run_id')) return { rowCount: 1, rows: [{ run_id: env.LOAD_RUN_ID }] };
    if (sql.includes('AS users,')) return { rows: [{ users: 110, sessions: 110, tenants: 10, rooms: 100 }] };
    if (sql.includes('AS count FROM jsonb_to_recordset')) return { rows: [{ count: JSON.parse(values[0]).length }] };
    if (sql.startsWith('INSERT')) mutations += 1;
    return { rows: [] };
  }, release() {} };
  return { env, manifest, clock: () => NOW, async verifyDatabase() {},
    persistenceFactory: () => ({ pool: { async connect() { return client; } }, async close() { closed += 1; } }),
    queries, mutations: () => mutations, closed: () => closed };
}

test('growth retains existing actor cookies and issues only the next bounded Employee population transactionally', async () => {
  const f = await fixture(); const grown = await growTargetLoadPopulation(f);
  assert.equal(grown.employees.length, 1000); assert.deepEqual(grown.employees.slice(0, 100), f.manifest.employees);
  assert.deepEqual(grown.managers, f.manifest.managers); assert.equal(f.mutations(), 4); assert.equal(f.closed(), 1);
  assert.equal(f.queries.at(-1).sql, 'COMMIT');
  assert.equal(JSON.stringify(f.queries).includes('cm_session='), false);
});

test('growth rejects same/shrinking populations and failed scope before mutation and hides dependency details', async () => {
  const f = await fixture();
  await assert.rejects(growTargetLoadPopulation({ ...f, env: { ...f.env, LOAD_FIXTURE_USERS: '100' } }));
  await assert.rejects(growTargetLoadPopulation({ ...f, async verifyDatabase() { throw new Error('private-database-material'); } }),
    /^Error: LOAD_TARGET_GROWTH_FAILED$/);
  assert.equal(f.mutations(), 0); assert.equal(f.closed(), 1);
});

test('manifest/database population mismatch rolls back before any token issuance or fixture write', async () => {
  const f = await fixture(); let released = false; const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith('SELECT run_id')) return { rowCount: 1, rows: [{ run_id: f.env.LOAD_RUN_ID }] };
    return { rows: [{ users: 111, sessions: 110, tenants: 10, rooms: 100 }] };
  }, release() { released = true; } };
  await assert.rejects(growTargetLoadPopulation({ ...f, persistenceFactory: () => ({
    pool: { async connect() { return client; } }, async close() {},
  }) }), /^Error: LOAD_TARGET_GROWTH_FAILED$/);
  assert.equal(queries.at(-1), 'ROLLBACK'); assert.equal(released, true);
  assert.equal(queries.some(sql => sql.startsWith('INSERT')), false);
});

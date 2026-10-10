import test from 'node:test';
import assert from 'node:assert/strict';
import { resetPostgresDemo } from '../scripts/support/demo-postgres-reset.mjs';
import { DEMO_FIXTURE_CHECKSUM, DEMO_FIXTURE } from '../src/demo/fixture.js';

function setup({ inconsistent = false, migrationFailure = false } = {}) {
  const events = [];
  let migrated = false;
  const migrationPool = Object.freeze({});
  const config = { databaseTarget: { database: 'conference_manager_demo_cli' }, databases: {
    customer: { role: 'cli_customer' }, platform: { role: 'cli_platform' }, reset: { role: 'cli_reset' },
  } };
  const resetPool = { async query(query) {
    events.push(query.name);
    assert.equal(migrated, true, 'bootstrap must create the overlay before inspecting its media relations');
    if (query.name === 'demo-media-storage-identity') {
      return { rows: [{ role: 'cli_reset', database: 'conference_manager_demo_cli' }] };
    }
    assert.equal(query.name, 'demo-media-storage-mode');
    assert.deepEqual(query.values, [false]);
    return { rows: [{ inconsistent }] };
  } };
  const dependencies = {
    async migrate(pool, { roles }) {
      events.push('migrate');
      assert.equal(pool, migrationPool);
      assert.deepEqual(roles, { customer: 'cli_customer', platform: 'cli_platform', reset: 'cli_reset' });
      if (migrationFailure) throw new Error('TEST_MIGRATION_FAILED');
      migrated = true;
    },
    createRepository(options) {
      events.push('repository');
      assert.equal(options.pool, resetPool);
      assert.equal(options.expectedResetRole, 'cli_reset');
      assert.equal(options.mediaObjects, undefined);
      return { async reset({ fixture, checksum }) {
        events.push('reset');
        return { seedVersion: fixture.seedVersion, checksum };
      } };
    },
  };
  return { events, run: () => resetPostgresDemo({ config, migrationPool, resetPool }, dependencies) };
}

test('PostgreSQL CLI keeps overlay bootstrap before guard and canonical reset', async () => {
  const state = setup();
  assert.deepEqual(await state.run(), { seedVersion: DEMO_FIXTURE.seedVersion, checksum: DEMO_FIXTURE_CHECKSUM });
  assert.deepEqual(state.events, ['migrate', 'demo-media-storage-identity', 'demo-media-storage-mode', 'repository', 'reset']);
});

test('PostgreSQL CLI refuses external media pointers before creating or executing the destructive reset', async () => {
  const state = setup({ inconsistent: true });
  await assert.rejects(state.run(), { code: 'DEMO_MEDIA_STORAGE_MODE_MISMATCH' });
  assert.deepEqual(state.events, ['migrate', 'demo-media-storage-identity', 'demo-media-storage-mode']);
});

test('failed overlay bootstrap never attempts media inspection or reset', async () => {
  const state = setup({ migrationFailure: true });
  await assert.rejects(state.run(), /TEST_MIGRATION_FAILED/);
  assert.deepEqual(state.events, ['migrate']);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadDemoMigrations,
  migrateDemoUp,
} from '../scripts/demo-db-migrations.mjs';
import { loadMigrations } from '../scripts/db-migrations.mjs';

const ROLES = Object.freeze({
  customer: 'demo_customer',
  platform: 'demo_platform',
  reset: 'demo_reset',
});

test('Demo migration stream is versioned independently from Production', async () => {
  const [production, demo] = await Promise.all([loadMigrations(), loadDemoMigrations()]);
  assert.equal(production.at(-1).version, 33);
  assert.equal(demo.length, 1);
  assert.equal(demo[0].version, 1);
  assert.equal(demo[0].name, 'demo_runtime_foundation');
  assert.match(demo[0].checksum, /^[0-9a-f]{64}$/);
  assert.match(demo[0].up, /CREATE TABLE demo_database_sentinel/);
  assert.match(demo[0].up, /ENABLE ALWAYS TRIGGER demo_database_sentinel_immutable/);
  assert.match(demo[0].up, /ENABLE ALWAYS TRIGGER demo_provider_simulation_immutable/);
  assert.match(demo[0].up, /ENABLE ALWAYS TRIGGER demo_persona_reference_immutable/);
  assert.match(demo[0].up, /demo_customer_persona_references TO %I/);
  assert.match(demo[0].up, /demo_platform_persona_references, demo_provider_simulations TO %I/);
  assert.match(demo[0].up, /platform_write_tables text\[\] := ARRAY\[[\s\S]*?'audit_events'/);
  assert.match(
    demo[0].up,
    /platform_write_tables text\[\] := ARRAY\[[\s\S]*?'microsoft365_room_mappings', 'microsoft365_capability_health'/,
  );
  assert.match(
    demo[0].up,
    /ALTER FUNCTION project_tenant_audit_diagnostic_event\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, public/,
  );
  assert.match(
    demo[0].up,
    /REVOKE ALL ON FUNCTION project_tenant_audit_diagnostic_event\(\) FROM PUBLIC/,
  );
  assert.doesNotMatch(
    demo[0].up,
    /GRANT [^;]*platform_diagnostic_events[^;]*customer_role/,
  );
  assert.doesNotMatch(demo[0].up, /demo_runtime_generations/);
  assert.doesNotMatch(demo[0].up, /CREATE TABLE schema_migrations/);
});

test('Demo migration runner reads Production readiness but writes only its own ledger', async () => {
  const queries = [];
  const client = {
    async query(query, values) {
      queries.push({ query, values });
      if (query?.name === 'demo-migration-production-schema') {
        return { rows: [{ versions: Array.from({ length: 33 }, (_, index) => index + 1) }] };
      }
      if (typeof query === 'string' && query.includes('SELECT version, name, checksum')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  await migrateDemoUp({ async connect() { return client; } }, { roles: ROLES });
  const text = queries.map(({ query }) => typeof query === 'string' ? query : query.text).join('\n');
  assert.match(text, /CREATE TABLE IF NOT EXISTS demo_schema_migrations/);
  assert.match(text, /INSERT INTO demo_schema_migrations/);
  assert.doesNotMatch(text, /(?:CREATE|INSERT INTO|DELETE FROM) schema_migrations/);
  assert.match(text, /pg_advisory_lock/);
  assert.match(text, /pg_advisory_unlock/);
});

test('Demo migration runner rejects a gapped Production migration ledger', async () => {
  const queries = [];
  const client = {
    async query(query) {
      queries.push(query);
      if (query?.name === 'demo-migration-production-schema') {
        return { rows: [{ versions: [1, ...Array.from({ length: 31 }, (_, index) => index + 3), 33] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    migrateDemoUp({ async connect() { return client; } }, { roles: ROLES }),
    /DEMO_MIGRATION_PRODUCTION_SCHEMA_NOT_READY/,
  );
  const text = queries.map((query) => typeof query === 'string' ? query : query.text).join('\n');
  assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS demo_schema_migrations/);
});

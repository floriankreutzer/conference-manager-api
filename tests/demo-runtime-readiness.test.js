import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEMO_FIXTURE } from '../src/demo/fixture.js';
import { DEMO_OVERLAY_MIGRATION_VERSION } from '../src/demo/runtime-contract.js';
import { createPostgresDemoRuntimeReadiness } from '../src/persistence/postgres/demo-runtime-readiness.js';

const DATABASE = 'conference_manager_demo_test';
const SENTINEL = 'conference-manager-shared-demo-v1';
const OVERLAY_VERSIONS = Array.from(
  { length: DEMO_OVERLAY_MIGRATION_VERSION },
  (_, index) => index + 1,
);

function row(surface, overrides = {}) {
  const role = `demo_${surface}`;
  return {
    connected_database: DATABASE,
    connected_role: role,
    sentinel_key: SENTINEL,
    runtime_schema_version: 1,
    database_name: DATABASE,
    recorded_role: role,
    overlay_versions: OVERLAY_VERSIONS,
    persona_keys: surface === 'customer'
      ? DEMO_FIXTURE.customerPersonas.map(({ tenantId, persona }) => `${tenantId}:${persona}`).sort()
      : DEMO_FIXTURE.platform.personas.map(({ persona }) => persona).sort(),
    authority_count: surface === 'customer'
      ? DEMO_FIXTURE.customerPersonas.length
      : DEMO_FIXTURE.platform.personas.length,
    ...(surface === 'platform'
      ? { provider_tenant_ids: DEMO_FIXTURE.tenants.map(({ id }) => id).sort() }
      : {}),
    ...overrides,
  };
}

function readiness(surface, resultRow) {
  const queries = [];
  const value = createPostgresDemoRuntimeReadiness({
    pool: {
      async query(query) {
        queries.push(query);
        return { rowCount: resultRow ? 1 : 0, rows: resultRow ? [resultRow] : [] };
      },
    },
    surface,
    expectedDatabaseName: DATABASE,
    expectedRole: `demo_${surface}`,
    expectedSentinelKey: SENTINEL,
  });
  return { value, queries };
}

for (const surface of ['customer', 'platform']) {
  test(`${surface} Demo readiness verifies database, role, sentinel, overlay and seed`, async () => {
    const { value, queries } = readiness(surface, row(surface));
    assert.equal(await value.assertReady(), true);
    assert.match(queries[0].text, /FROM demo_schema_migrations/);
    assert.match(queries[0].text, new RegExp(`FROM demo_${surface}_persona_references`));
    if (surface === 'platform') assert.match(queries[0].text, /FROM demo_provider_simulations/);
  });

  test(`${surface} Demo readiness fails closed for mismatched runtime state`, async () => {
    for (const override of [
      { connected_role: 'unexpected_role' },
      { sentinel_key: 'unexpected' },
      { overlay_versions: OVERLAY_VERSIONS.slice(0, -1) },
      { overlay_versions: [...OVERLAY_VERSIONS, DEMO_OVERLAY_MIGRATION_VERSION + 1] },
      { persona_keys: [] },
      { persona_keys: [...row(surface).persona_keys, 'unexpected-persona'] },
      { authority_count: 0 },
      ...(surface === 'platform' ? [{ provider_tenant_ids: [] },
        { provider_tenant_ids: [...row(surface).provider_tenant_ids, 'unexpected-tenant'] }] : []),
    ]) {
      const { value } = readiness(surface, row(surface, override));
      assert.equal(await value.isReady(), false);
      await assert.rejects(value.assertReady(), /DEMO_RUNTIME_NOT_READY/);
    }
  });

  test(`${surface} running readiness bounds every inventory and retains fresh authority checks`, async () => {
    const current = row(surface);
    const { value, queries } = readiness(surface, current);
    assert.equal(await value.isReady(), true);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].name, `demo-${surface}-bounded-readiness`);
    assert.deepEqual(queries[0].values, [current.persona_keys.length + 1, OVERLAY_VERSIONS.length + 1,
      ...(surface === 'platform' ? [DEMO_FIXTURE.tenants.length + 1] : [])]);
    assert.match(queries[0].text, /persona_inventory AS MATERIALIZED[\s\S]*LIMIT \$1/);
    assert.match(queries[0].text, /overlay_inventory AS MATERIALIZED[\s\S]*LIMIT \$2/);
    assert.match(queries[0].text, /FROM persona_inventory AS reference/);
    current.authority_count = 0;
    assert.equal(await value.isReady(), false);
    current.authority_count = current.persona_keys.length;
    assert.equal(await value.isReady(), true);
    assert.equal(queries.length, 3);
    assert.equal(await value.assertReady(), true);
    assert.equal(queries[3].name, `demo-${surface}-startup-integrity`);
    assert.doesNotMatch(queries[3].text, /LIMIT/);
    assert.deepEqual(queries[3].values, []);
  });
}

test('Demo readiness reports dependency query failures as not ready', async () => {
  const value = createPostgresDemoRuntimeReadiness({
    pool: { async query() { throw new Error('connection details must not escape'); } },
    surface: 'customer',
    expectedDatabaseName: DATABASE,
    expectedRole: 'demo_customer',
    expectedSentinelKey: SENTINEL,
  });
  assert.equal(await value.isReady(), false);
});

test('both Demo composition roots assert integrity before starting their HTTP listener', () => {
  for (const surface of ['customer', 'platform']) {
    const source = readFileSync(new URL(`../src/demo/${surface}-composition.js`, import.meta.url), 'utf8');
    const assertion = source.indexOf('await selectedReadiness.assertReady();');
    const listener = source.indexOf('return composition.start();', assertion);
    assert.notEqual(assertion, -1);
    assert.equal(listener > assertion, true);
    assert.match(source, /readinessChecks: Object\.freeze\(\[[\s\S]*selectedReadiness\.isReady\(\)/);
  }
});

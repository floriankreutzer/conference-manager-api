import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, CURRENT_SCHEMA_VERSION } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { collectProtectedRuntimeObservation } from '../scripts/support/protected-runtime-observation-collector.mjs';
import { reconcileProtectedRuntimeObservation } from '../scripts/support/protected-runtime-observation-reconciler.mjs';
import { runtimeObservationFixture } from '../tests/support/runtime-observation-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { withProtectedRuntimeSharedGate } from '../src/persistence/postgres/protected-runtime-gate.js';
import { SYNTHETIC_GENERATION_COOLDOWN_MS } from '../src/domain/synthetic-generation-lifecycle.js';

test('native observer preserves data across authoritative routing, rollback, duplicate, reset and epoch fencing', async t => {
  const config = { mode: 'test', ...loadDatabaseConfig(process.env, 'test'), databasePoolMax: 2 };
  if (!config.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool(config), leasePool = createPostgresPool({ ...config, databasePoolMax: 1 });
  t.after(async () => { await pool.end();await leasePool.end(); });await migrateUp(pool);
  const epoch = randomUUID(), scope = { environment: 'int', securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)", [epoch]);
  const role = (await pool.query('SELECT current_user AS role')).rows[0].role;
  const f = await runtimeObservationFixture(t, epoch);
  const actor = await createProtectedSyntheticOperatorFixture(pool, leasePool, { epoch, scopeMode: 'all' });
  const tenantAudit = createPostgresAuditRepository(pool, { hmacSecret: 't'.repeat(48) });
  const generation = createSyntheticGenerationService({ ...scope, passkeyService: actor.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(), repository: createPostgresSyntheticGenerationRepository(pool,
      { ...scope, tenantAuditRepository: tenantAudit, platformAuditRepository: actor.auditRepository }) });
  async function replace(previous = null) {
    const intent = { operatorId: actor.operatorId, expectedGenerationId: previous?.generationId ?? null,
      expectedRevision: previous?.revision ?? 0 };
    return actor.execute(generation.operationHash(intent), proofContext => generation.replace({ proofContext, intent,
      correlationId: randomUUID() }));
  }
  const first = await replace();
  const real = randomUUID(), unknown = randomUUID(), other = randomUUID();
  await pool.query(`INSERT INTO tenants(id,display_name,status) VALUES
    ($1,'Real observer fixture','active'),($2,'Unclassified','active'),($3,'Other environment','active')`,
    [real, unknown, other]);
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('dev',$1)", [randomUUID()]);
  await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode)
    VALUES('int',$1,'real'),('dev',$2,'real')`, [real, other]);
  const collect = () => collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root, fetchImpl: f.fetchImpl });
  const before = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM requests) AS requests,(SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM audit_events) AS tenant_audit,(SELECT count(*)::int FROM platform_audit_events) AS platform_audit,
    (SELECT count(*)::int FROM synthetic_tenant_generations) AS generations`)).rows[0];
  const baseline = await before();
  const failedReceipt = await collect();let injected = false;
  const faultPool = { async connect() {
    const client = await pool.connect();return { async query(sql, values) {
      const result = await client.query(sql, values);
      if (!injected && typeof sql === 'string' && sql.includes('INSERT INTO platform_runtime_tenant_mappings')) {
        injected = true;throw new Error('PRIVATE_FAULT_AFTER_REAL_MAPPING_WRITE');
      }
      return result;
    }, release: error => client.release(error) };
  } };
  await assert.rejects(() => reconcileProtectedRuntimeObservation(faultPool, failedReceipt,
    { expectedOfflineRole: role }), /OBSERVATION_REFUSED/);
  assert.equal(injected, true);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_runtime_deployments')).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_runtime_tenant_mappings')).rows[0].count, 0);
  assert.deepEqual(await before(), baseline);

  // Same provider reference in another environment cannot hide an additional
  // INT observation from the bounded global reader. Discard probe rows by
  // rolling back this fixture transaction, preserving all retention triggers.
  await assert.rejects(() => withProtectedRuntimeSharedGate(pool, 'int', async client => {
    const references = [f.plan.customer, f.plan.platform].map(row => `render:${row.deploymentReference}`);
    references.push(...Array.from({ length: 47 }, (_, index) => `retained:${index}`));
    await client.query(`INSERT INTO platform_runtime_deployments(id,environment,deployment_reference,deployed_at,
      frontend_environment,api_environment,schema_environment,dependencies_environment)
      SELECT id,'production',reference,clock_timestamp(),'production','production','production','production'
      FROM unnest($1::uuid[],$2::text[]) AS source(id,reference)`, [references.map(() => randomUUID()), references]);
    const boundedReceipt = await collect();
    await assert.rejects(() => reconcileProtectedRuntimeObservation(pool, boundedReceipt, { expectedOfflineRole: role }));
    assert.equal((await client.query('SELECT count(*)::int AS count FROM platform_runtime_deployments')).rows[0].count, 49);
    throw new Error('ROLLBACK_OBSERVER_CAPACITY_FIXTURE');
  }), /ROLLBACK_OBSERVER_CAPACITY_FIXTURE/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_runtime_deployments')).rows[0].count, 0);

  const receipt = await collect();
  const attempts = await Promise.allSettled([1, 2].map(() => reconcileProtectedRuntimeObservation(pool, receipt,
    { expectedOfflineRole: role })));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  const result = attempts.find(row => row.status === 'fulfilled').value;
  assert.equal(result.deployments, 2);assert.equal(result.routedTenants, 4);
  assert.equal(result.databaseSchemaVersion, CURRENT_SCHEMA_VERSION);
  const identityQuery = 'SELECT service_instance_key,service_surface FROM platform_runtime_deployments ORDER BY service_surface';
  const identities = await pool.query(identityQuery);
  assert.deepEqual(identities.rows, [
    { service_instance_key: 'protected-int-customer', service_surface: 'customer' },
    { service_instance_key: 'protected-int-platform', service_surface: 'platform' },
  ]);
  await assert.rejects(() => pool.query(`UPDATE platform_runtime_deployments
    SET service_instance_key='forged',revision=revision+1,updated_at=clock_timestamp()`), /SERVICE_IDENTITY_IMMUTABLE/);
  assert.deepEqual((await pool.query(identityQuery)).rows, identities.rows);
  await assert.rejects(() => rollbackLatest(pool), /PLATFORM_RUNTIME_SERVICE_IDENTITY_RETAINED/);
  assert.deepEqual((await pool.query(identityQuery)).rows, identities.rows);
  assert.doesNotMatch(JSON.stringify(result), new RegExp([real, unknown, other, epoch, actor.operatorId].join('|')));
  const mappings = await pool.query(`SELECT m.tenant_id,d.deployment_reference,d.schema_current_version,
    d.required_dependencies_state,d.optional_dependencies_state FROM platform_runtime_tenant_mappings m
    JOIN platform_runtime_deployments d ON d.id=m.deployment_id ORDER BY m.tenant_id`);
  assert.deepEqual(mappings.rows.map(row => row.tenant_id).sort(), [real, ...first.tenants.map(row => row.tenantId)].sort());
  assert.ok(mappings.rows.every(row => row.deployment_reference === `render:${f.plan.customer.deploymentReference}`
    && row.schema_current_version === CURRENT_SCHEMA_VERSION && row.required_dependencies_state === 'ready'
    && row.optional_dependencies_state === 'unknown'));
  assert.deepEqual(await before(), baseline);
  await assert.rejects(() => reconcileProtectedRuntimeObservation(pool, structuredClone(receipt), { expectedOfflineRole: role }));
  await assert.rejects(() => reconcileProtectedRuntimeObservation(pool, receipt, { expectedOfflineRole: 'wrong_owner' }));
  const ledger = (await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version LIMIT 1')).rows[0];
  try {
    await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1', [ledger.version, 'f'.repeat(64)]);
    const changedLedgerReceipt = await collect();
    await assert.rejects(() => reconcileProtectedRuntimeObservation(pool, changedLedgerReceipt, { expectedOfflineRole: role }));
  } finally {
    await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1', [ledger.version, ledger.checksum]);
  }
  const expired = await collectProtectedRuntimeObservation({ plan: f.plan, artifactRoot: f.root,
    fetchImpl: f.fetchImpl, clock: () => Date.now() - 121000 });
  await assert.rejects(() => reconcileProtectedRuntimeObservation(pool, expired, { expectedOfflineRole: role }));

  // Respect the real generation cooldown before issuing a new reset intent.
  // No database clock, generation timestamp or security expiry is rewritten.
  await new Promise(resolve => setTimeout(resolve, SYNTHETIC_GENERATION_COOLDOWN_MS + 100));
  await actor.freshSession();const next = await replace(first);
  const afterReset = await before();
  const refreshed = await reconcileProtectedRuntimeObservation(pool, await collect(), { expectedOfflineRole: role });
  assert.equal(refreshed.routedTenants, 4);
  const retained = (await pool.query('SELECT tenant_id FROM platform_runtime_tenant_mappings')).rows.map(row => row.tenant_id);
  assert.deepEqual(retained.sort(), [real, ...first.tenants.map(row => row.tenantId), ...next.tenants.map(row => row.tenantId)].sort());
  assert.deepEqual(await before(), afterReset);

  const stale = await collect();
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`, [randomUUID()]);
  const revisions = await pool.query('SELECT id,revision,observed_at FROM platform_runtime_deployments ORDER BY id');
  await assert.rejects(() => reconcileProtectedRuntimeObservation(pool, stale, { expectedOfflineRole: role }), /OBSERVATION_REFUSED/);
  assert.deepEqual((await pool.query('SELECT id,revision,observed_at FROM platform_runtime_deployments ORDER BY id')).rows, revisions.rows);
  assert.deepEqual(await before(), afterReset);
});

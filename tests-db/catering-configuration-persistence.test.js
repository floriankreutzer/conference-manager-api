import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresCateringConfigurationRepository } from '../src/persistence/postgres/catering-configuration-repository.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createProviderRegistry } from '../src/integrations/provider-registry.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const id = (number) => `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tenantId = id(1);
const otherTenant = id(2);
const integrationId = id(3);
const actorUserId = id(4);
const otherActor = id(5);
const otherIntegration = id(6);
const sessionId = id(7);
const correlationId = id(9);
const configuration = (mode = 'manager_review') => ({ initialOrderMode: mode, capabilities: { 'catering.order': 'api' } });

test('Catering configuration commits scoped revisions and audit atomically and fences stale or revoked writers', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database, databasePoolMax: 6 });
  t.after(async () => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [
    { id: 'reference_one', runtime: 'production', capabilities: { 'catering.order': 'api' } },
    { id: 'reference_two', runtime: 'production', capabilities: { 'catering.order': 'manual' } },
  ] });
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'synthetic-catering-configuration-audit-key' });
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditService({ repository: auditRepository, authorizationPolicy });
  const repository = createPostgresCateringConfigurationRepository(pool, { registry, auditRepository });
  for (const [tenant, user, integration] of [[tenantId, actorUserId, integrationId], [otherTenant, otherActor, otherIntegration]]) {
    await pool.query('INSERT INTO tenants (id, display_name, status) VALUES ($1,$2,$3)', [tenant, 'Synthetic Catering Tenant', 'active']);
    await pool.query('INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,$3)', [tenant, user, 'Synthetic Admin']);
    await pool.query(`INSERT INTO integrations (tenant_id,id,provider,provider_reference,status)
      VALUES ($1,$2,'reference_one',$3,'pending')`, [tenant, integration, `synthetic:${integration}`]);
  }
  await pool.query(`INSERT INTO sessions (id,tenant_id,user_id,token_hash,provider,provider_identity_reference,
    roles,permissions,principal_version,issued_at,expires_at)
    VALUES ($1,$2,$3,$4,'reference_identity','synthetic-admin',ARRAY['tenant_admin'],
      ARRAY['tenant:integrations:manage'],1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day')`,
  [sessionId, tenantId, actorUserId, 'a'.repeat(64)]);
  const principal = { tenantId, userId: actorUserId, roles: ['tenant_admin'], permissions: ['tenant:integrations:manage'] };
  function command(expectedRevision, override = {}) {
    return {
      tenantId, integrationId, providerId: 'reference_one', actorUserId, sessionId,
      expectedSecurityVersion: 1, expectedRevision, configuration: configuration(), correlationId, changedAt: new Date(),
      auditEventFor({ revision }) {
        return audit.createEvent({
          principal, tenantContext: { tenantId, status: 'active' }, correlationId,
          action: 'tenant.configuration.changed', targetType: 'integration', targetId: integrationId,
          previousState: { revision: expectedRevision }, newState: { revision }, outcome: 'success',
          metadata: { operation: expectedRevision === 0 ? 'catering_configuration_initialize' : 'catering_configuration_update' },
          retentionClass: 'administrative',
        });
      },
      ...override,
    };
  }
  const first = await repository.initialize(command(0));
  assert.equal(first.status, 'updated');
  assert.equal(first.current.revision, 1);
  assert.equal(first.current.configuration.capabilities['catering.order'], 'api');
  assert.equal((await repository.initialize(command(0))).status, 'conflict');
  assert.equal(await repository.loadCurrent({ tenantId, integrationId: otherIntegration }), null);
  assert.equal((await repository.update(command(1, { integrationId: otherIntegration }))).status, 'not_found');
  assert.equal((await repository.update(command(1, { tenantId: otherTenant }))).status, 'not_authorized');
  assert.equal((await repository.update(command(1, {
    providerId: 'reference_two', configuration: { initialOrderMode: 'manager_review', capabilities: { 'catering.order': 'manual' } },
  }))).status, 'not_found');

  const failedAudit = createPostgresCateringConfigurationRepository(pool, { registry, auditRepository: {
    async appendWithClient() { throw new Error('SYNTHETIC_AUDIT_FAILURE'); },
  } });
  await assert.rejects(failedAudit.update(command(1)), /SYNTHETIC_AUDIT_FAILURE/);
  assert.equal((await repository.loadCurrent({ tenantId, integrationId })).revision, 1);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_integration_configuration_revisions')).rows[0].count, 1);
  const concurrent = await Promise.all([
    repository.update(command(1, { configuration: configuration('after_conference_approval') })),
    repository.update(command(1, { configuration: configuration('after_conference_approval') })),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), ['conflict', 'updated']);
  const restarted = createPostgresCateringConfigurationRepository(pool, { registry, auditRepository });
  assert.equal((await restarted.loadCurrent({ tenantId, integrationId })).revision, 2);
  assert.equal((await restarted.loadCurrent({ tenantId, integrationId })).configuration.initialOrderMode, 'after_conference_approval');
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_integration_configuration_revisions')).rows[0].count, 2);
  assert.deepEqual((await pool.query(`SELECT revision::integer,initial_order_mode
    FROM catering_integration_configuration_revisions ORDER BY revision`)).rows, [
    { revision: 1, initial_order_mode: 'manager_review' }, { revision: 2, initial_order_mode: 'after_conference_approval' },
  ]);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM audit_events WHERE tenant_id=$1', [tenantId])).rows[0].count, 2);
  assert.equal(await auditRepository.verifyTenantChain(tenantId), true);
  await assert.rejects(repository.update(command(2, {
    auditEventFor({ revision }) { return { ...command(2).auditEventFor({ revision }), tenantId: otherTenant }; },
  })), /CATERING_CONFIGURATION_AUDIT_SCOPE_INVALID/);
  assert.equal((await repository.loadCurrent({ tenantId, integrationId })).revision, 2);

  for (const [setup, restore] of [
    ["UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1", 'UPDATE sessions SET revoked_at=NULL WHERE id=$1'],
    ["UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      "UPDATE sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1"],
    ["UPDATE sessions SET roles=ARRAY['employee']::text[] WHERE id=$1",
      "UPDATE sessions SET roles=ARRAY['tenant_admin']::text[] WHERE id=$1"],
  ]) {
    await pool.query(setup, [sessionId]);
    assert.equal((await repository.update(command(2))).status, 'not_authorized');
    await pool.query(restore, [sessionId]);
  }
  await pool.query("UPDATE tenants SET status='suspended' WHERE id=$1", [tenantId]);
  assert.equal((await repository.update(command(2))).status, 'not_authorized');
  await pool.query("UPDATE tenants SET status='active' WHERE id=$1", [tenantId]);
  await pool.query('UPDATE users SET security_version=2 WHERE tenant_id=$1 AND id=$2', [tenantId, actorUserId]);
  assert.equal((await repository.update(command(2))).status, 'not_authorized');
  assert.equal((await repository.loadCurrent({ tenantId, integrationId })).revision, 2);

  await assert.rejects(pool.query(`UPDATE catering_integration_configurations SET revision=revision+2
    WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]), (error) => error.code === '23514');
  await assert.rejects(pool.query(`UPDATE catering_integration_configurations SET revision=revision+1
    WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]), (error) => error.code === '23503');
  await assert.rejects(pool.query(`UPDATE catering_integration_configurations SET revision=revision+1,order_mode='invented'
    WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]), (error) => error.code === '23514');
  await assert.rejects(pool.query(`UPDATE catering_integration_configurations SET revision=revision+1,updated_by_user_id=$3
    WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId, otherActor]), (error) => error.code === '23503');
  await assert.rejects(pool.query('DELETE FROM catering_integration_configuration_revisions'), /APPEND_ONLY/);
  // A fresh authoritative version-2 session is needed after the security-version denial above.
  await pool.query(`INSERT INTO sessions (id,tenant_id,user_id,token_hash,provider,provider_identity_reference,
    roles,permissions,principal_version,issued_at,expires_at)
    VALUES ($1,$2,$3,$4,'reference_identity','synthetic-admin',ARRAY['tenant_admin'],
      ARRAY['tenant:integrations:manage'],2,clock_timestamp(),clock_timestamp()+interval '1 day')`,
  [id(12), tenantId, actorUserId, 'b'.repeat(64)]);
  function creation(objectId, commandId = id(13), overrides = {}) {
    return command(0, {
      integrationId: objectId, commandId, sessionId: id(12), expectedSecurityVersion: 2,
      auditEventFor({ revision }) {
        return { ...command(0).auditEventFor({ revision }), targetId: objectId,
          metadata: { operation: 'catering_configuration_create' } };
      }, ...overrides,
    });
  }
  const created = await Promise.all([repository.create(creation(id(10))), repository.create(creation(id(11)))]);
  assert.equal(created[0].status, 'updated');
  assert.equal(created[1].status, 'updated');
  assert.equal(created[0].current.integrationId, created[1].current.integrationId);
  assert.equal(created.filter((value) => value.replayed === true).length, 1);
  const createdId = created[0].current.integrationId;
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM integrations WHERE tenant_id=$1', [tenantId])).rows[0].count, 2);
  assert.equal((await repository.create(creation(id(14), id(13), {
    configuration: configuration('after_conference_approval'),
  }))).status, 'conflict');
  assert.equal((await pool.query('SELECT status FROM integrations WHERE tenant_id=$1 AND id=$2', [tenantId, createdId])).rows[0].status,
    'configured');
  await assert.rejects(failedAudit.create(creation(id(15), id(16))), /SYNTHETIC_AUDIT_FAILURE/);
  assert.equal((await pool.query('SELECT id FROM integrations WHERE tenant_id=$1 AND id=$2', [tenantId, id(15)])).rowCount, 0);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [id(12)]);
  assert.equal((await repository.create(creation(id(15), id(16)))).status, 'not_authorized');
  await pool.query('UPDATE sessions SET revoked_at=NULL WHERE id=$1', [id(12)]);
  for (let index = 20; index < 41; index += 1) {
    assert.equal((await repository.create(creation(id(index), id(index + 100)))).status, 'updated');
  }
  const firstPage = await repository.listCurrent({ tenantId });
  assert.equal(firstPage.items.length, 20);
  assert.equal(firstPage.nextAfterIntegrationId, firstPage.items.at(-1).integrationId);
  const secondPage = await restarted.listCurrent({ tenantId, afterIntegrationId: firstPage.nextAfterIntegrationId });
  assert.equal(secondPage.items.length, 3);
  assert.equal(secondPage.nextAfterIntegrationId, null);
  const identities = [...firstPage.items, ...secondPage.items].map((value) => value.integrationId);
  assert.equal(new Set(identities).size, 23);
  assert.deepEqual(identities, identities.slice().sort());
  assert.deepEqual((await repository.listCurrent({ tenantId: otherTenant })).items, []);
  assert.equal(await auditRepository.verifyTenantChain(tenantId), true);
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering delivery schema 049.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering order schema 048.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering assignment schema 047.
  await assert.rejects(rollbackLatest(pool), /CATERING_CONFIGURATION_ROLLBACK_REQUIRES_REVIEW/);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering delivery schema 049.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering order schema 048.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering assignment schema 047.
  await pool.query('TRUNCATE catering_integration_configuration_revisions,catering_integration_configurations');
  await rollbackLatest(pool);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createCateringCatalogueAssignmentService } from '../src/application/catering-catalogue-assignment-service.js';
import { createTenantCatalogueService } from '../src/application/tenant-catalogue-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createCateringConfigurationRouteModules } from '../src/catering-configuration-composition.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createHttpServer } from '../src/server.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresCateringCatalogueAssignmentRepository,
} from '../src/persistence/postgres/catering-catalogue-assignment-repository.js';
import { createPostgresCateringConfigurationRepository } from '../src/persistence/postgres/catering-configuration-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantCatalogueRepository } from '../src/persistence/postgres/tenant-catalogue-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const id = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entity = (name, extra = {}) => ({ id: name, name, description: null, active: true, order: 0,
  price: { amountMinor: 100, currency: 'EUR' }, siteIds: [], roomIds: [], ...extra });
const empty = () => ({ services: [], equipment: [], cateringItems: [], cateringPackages: [] });
const catalogue = () => ({ ...empty(), cateringItems: [entity('coffee'), entity('fruit')],
  cateringPackages: [entity('break', { itemIds: ['coffee'], variants: [] })] });
const assignments = () => [
  { kind: 'item', entryId: 'coffee', integrationId: id(11) },
  { kind: 'item', entryId: 'fruit', integrationId: id(12) },
  { kind: 'package', entryId: 'break', integrationId: id(11) },
];

test('versioned Catering ownership is canonical, scoped, sealed, CAS/audit atomic and fenced by live Manager authority', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database, databasePoolMax: 6 });
  t.after(() => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const registry = createCateringConfigurationRegistry();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'synthetic-catering-catalogue-audit-key-32-bytes' });
  const authorizationPolicy = createAuthorizationPolicy();
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const repository = createPostgresCateringCatalogueAssignmentRepository(pool, { registry, auditRepository });
  const service = createCateringCatalogueAssignmentService({ repository, auditService, authorizationPolicy });
  const catalogueService = createTenantCatalogueService({ authorizationPolicy, auditService,
    repository: createPostgresTenantCatalogueRepository(pool, { auditRepository }) });
  const configurationRepository = createPostgresCateringConfigurationRepository(pool, { registry, auditRepository });

  async function seedTenant(tenant, manager, admin) {
    await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Synthetic Catering Tenant','active')", [id(tenant)]);
    for (const user of [manager, admin]) {
      await pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,'Synthetic Actor')", [id(tenant), id(user)]);
    }
  }
  async function seedSession(tenant, user, session, role, permission, version = 1) {
    await pool.query(`INSERT INTO sessions (id,tenant_id,user_id,token_hash,provider,provider_identity_reference,
      roles,permissions,principal_version,issued_at,expires_at)
      VALUES ($1,$2,$3,$4,'test_identity','synthetic',ARRAY[$5]::text[],ARRAY[$6]::text[],$7,
        clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`,
    [id(session), id(tenant), id(user), String(session).padStart(64, '0'), role, permission, version]);
  }
  function context(tenant = 1, user = 3, session = 7, version = 1) {
    return { principal: { tenantId: id(tenant), userId: id(user), roles: ['conference_manager'],
      permissions: ['tenant:catalogue:manage'], session: { id: id(session), securityVersion: version } },
    tenantContext: { tenantId: id(tenant), status: 'active' }, correlationId: id(99) };
  }
  function configCommand(tenant, admin, session, integration, expectedRevision, enabled = true) {
    return { tenantId: id(tenant), integrationId: id(integration), providerId: 'manual_catering', actorUserId: id(admin),
      sessionId: id(session), expectedSecurityVersion: 1, expectedRevision, changedAt: new Date(), correlationId: id(99),
      configuration: { initialOrderMode: 'manager_review', capabilities: enabled ? { 'catering.order': 'manual' } : {} },
      auditEventFor({ revision }) { return auditService.createEvent({ principal: { tenantId: id(tenant), userId: id(admin) },
        tenantContext: { tenantId: id(tenant), status: 'active' }, correlationId: id(99), action: 'tenant.configuration.changed',
        targetType: 'integration', targetId: id(integration), previousState: { revision: expectedRevision }, newState: { revision },
        outcome: 'success', retentionClass: 'administrative', metadata: {
          operation: expectedRevision === 0 ? 'catering_configuration_initialize' : 'catering_configuration_update',
        } }); },
    };
  }
  async function seedConnection(tenant, admin, session, integration) {
    await pool.query(`INSERT INTO integrations (tenant_id,id,provider,provider_reference,status)
      VALUES ($1,$2,'manual_catering',$3,'configured')`, [id(tenant), id(integration), `synthetic:${integration}`]);
    assert.equal((await configurationRepository.initialize(configCommand(tenant, admin, session, integration, 0))).status, 'updated');
  }
  await seedTenant(1, 3, 4);
  await seedTenant(2, 5, 6);
  await seedSession(1, 3, 7, 'conference_manager', 'tenant:catalogue:manage');
  await seedSession(1, 4, 8, 'tenant_admin', 'tenant:integrations:manage');
  await seedSession(2, 5, 9, 'conference_manager', 'tenant:catalogue:manage');
  await seedSession(2, 6, 10, 'tenant_admin', 'tenant:integrations:manage');
  await seedConnection(1, 4, 8, 11);
  await seedConnection(1, 4, 8, 12);
  await seedConnection(2, 6, 10, 13);
  for (const ctx of [context(), context(2, 5, 9)]) {
    assert.equal((await catalogueService.update({ ...ctx, schemaVersion: 1, expectedRevision: 1, catalogue: catalogue() })).revision, 2);
  }
  const write = (expectedRevision = 0, catalogueRevision = 2) => ({ ...context(), schemaVersion: 1,
    expectedRevision, catalogueRevision, assignments: assignments() });
  assert.equal((await service.current(context())).revision, 0);
  const first = await service.replace(write());
  assert.equal(first.revision, 1);
  assert.equal(first.stale, false);
  const restarted = createPostgresCateringCatalogueAssignmentRepository(pool, { registry, auditRepository });
  assert.equal((await restarted.loadCurrent({ tenantId: id(1) })).revision, 1);
  const count = async (table, tenant = 1) => (await pool.query(
    `SELECT count(*)::integer AS count FROM ${table} WHERE tenant_id=$1`, [id(tenant)],
  )).rows[0].count;
  assert.equal(await count('catering_catalogue_assignment_seals'), 1);
  assert.equal(await count('catering_catalogue_assignment_entries'), 3);
  assert.deepEqual((await service.listConnections(context())).connections.map((entry) => entry.integrationId), [id(11), id(12)]);
  const foreign = { ...write(), ...context(2, 5, 9) };
  await assert.rejects(service.replace(foreign), /CONNECTION_UNKNOWN/);
  assert.equal(await count('catering_catalogue_assignment_heads', 2), 0);
  await assert.rejects(service.replace({ ...write(), principal: { ...context().principal,
    userId: id(4), session: { id: id(8), securityVersion: 1 } } }), /PRINCIPAL_NOT_AUTHORIZED/);

  const concurrent = await Promise.allSettled([service.replace(write(1)), service.replace(write(1))]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected'
    && result.reason.code === 'CATERING_ASSIGNMENT_REVISION_CONFLICT').length, 1);
  assert.equal(await count('catering_catalogue_assignment_revisions'), 2);
  assert.equal(await count('catering_catalogue_assignment_seals'), 2);
  const failedRepository = createPostgresCateringCatalogueAssignmentRepository(pool, { registry, auditRepository: {
    appendWithClient: async () => { throw new Error('SYNTHETIC_AUDIT_FAILURE'); },
  } });
  const failedService = createCateringCatalogueAssignmentService({ repository: failedRepository, authorizationPolicy, auditService });
  await assert.rejects(failedService.replace(write(2)), /SYNTHETIC_AUDIT_FAILURE/);
  assert.equal((await service.current(context())).revision, 2);
  assert.equal(await count('catering_catalogue_assignment_revisions'), 2);
  assert.equal(await count('catering_catalogue_assignment_entries'), 6);

  assert.equal((await configurationRepository.update(configCommand(1, 4, 8, 11, 1, false))).status, 'updated');
  assert.equal((await service.current(context())).stale, true);
  await assert.rejects(service.replace(write(2)), /CONNECTION_UNKNOWN/);
  assert.equal((await configurationRepository.update(configCommand(1, 4, 8, 11, 2, true))).status, 'updated');
  const changed = catalogue(); changed.cateringItems[0].price.amountMinor = 200;
  assert.equal((await catalogueService.update({ ...context(), schemaVersion: 1, expectedRevision: 2, catalogue: changed })).revision, 3);
  const stale = await service.current(context());
  assert.equal(stale.assignedCatalogueRevision, 2);
  assert.equal(stale.currentCatalogueRevision, 3);
  assert.equal(stale.stale, true);
  assert.equal((await pool.query(`SELECT snapshot->'cateringItems'->0->'price'->>'amountMinor' AS cost FROM tenant_catalogue_revisions
    WHERE tenant_id=$1 AND revision=2`, [id(1)])).rows[0].cost, '100');
  await assert.rejects(service.replace(write(2)), /TENANT_SETTINGS_REVISION_CONFLICT/);
  assert.equal((await service.replace(write(2, 3))).revision, 3);

  for (const [setup, restore] of [
    ['UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', 'UPDATE sessions SET revoked_at=NULL WHERE id=$1'],
    ["UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      "UPDATE sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1"],
    ["UPDATE sessions SET roles=ARRAY['tenant_admin']::text[] WHERE id=$1",
      "UPDATE sessions SET roles=ARRAY['conference_manager']::text[] WHERE id=$1"],
  ]) {
    await pool.query(setup, [id(7)]);
    await assert.rejects(service.replace(write(3, 3)), /PRINCIPAL_NOT_AUTHORIZED/);
    await pool.query(restore, [id(7)]);
  }
  await pool.query('UPDATE users SET security_version=2 WHERE tenant_id=$1 AND id=$2', [id(1), id(3)]);
  await assert.rejects(service.replace(write(3, 3)), /PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal((await service.current(context())).revision, 3);
  assert.equal(await auditRepository.verifyTenantChain(id(1)), true);

  await assert.rejects(pool.query(`INSERT INTO catering_catalogue_assignment_entries (tenant_id,revision,kind,entry_id,integration_id)
    VALUES ($1,3,'item','late-append',$2)`, [id(1), id(11)]), /REVISION_SEALED/);
  await assert.rejects(pool.query('DELETE FROM catering_catalogue_assignment_entries WHERE tenant_id=$1', [id(1)]), /APPEND_ONLY/);
  await assert.rejects(pool.query('UPDATE catering_catalogue_assignment_heads SET revision=revision+2 WHERE tenant_id=$1', [id(1)]),
    (error) => error.code === '23514');
  async function rawRevision(entries) {
    return withPostgresTransaction(pool, async (client) => {
      await client.query(`INSERT INTO catering_catalogue_assignment_revisions
        (tenant_id,revision,catalogue_revision,entry_count,changed_at,changed_by_user_id,correlation_id)
        VALUES ($1,4,3,3,clock_timestamp(),$2,$3)`, [id(1), id(3), id(99)]);
      for (const entry of entries) await client.query(`INSERT INTO catering_catalogue_assignment_entries
        (tenant_id,revision,kind,entry_id,integration_id) VALUES ($1,4,$2,$3,$4)`,
      [id(1), entry.kind, entry.entryId, entry.integrationId]);
      await client.query('UPDATE catering_catalogue_assignment_heads SET revision=4 WHERE tenant_id=$1', [id(1)]);
    });
  }
  await assert.rejects(rawRevision([]), /ASSIGNMENT_INCOMPLETE/);
  await assert.rejects(rawRevision(assignments().map((entry) => entry.kind === 'package' ? { ...entry, integrationId: id(12) } : entry)),
    /PACKAGE_PROVIDER_MISMATCH/);
  await assert.rejects(rawRevision(assignments().map((entry) => ({ ...entry, integrationId: id(13) }))),
    (error) => error.code === '23503');
  assert.equal(await count('catering_catalogue_assignment_revisions'), 3);
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
  assert.equal(await rollbackLatest(pool), true); // Remove empty delivery schema049 before the older rollback probe.
  assert.equal(await rollbackLatest(pool), true); // Empty order schema 048 before the populated assignment rollback probe.
  await assert.rejects(rollbackLatest(pool), /CATERING_CATALOGUE_ASSIGNMENT_ROLLBACK_REQUIRES_REVIEW/);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);

  // Full real HTTP/session/HMAC-CSRF + PostgreSQL progression, not a synthetic principal guard.
  const origin = 'http://localhost:3000';
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: origin, CATERING_CONFIGURATION_ENABLED: 'true' });
  const sessionService = createSessionService({
    repository: createPostgresSessionRepository(pool, { auditRepository }), auditService, publicOrigin: origin,
    csrfSecret: 'synthetic-catering-catalogue-http-csrf-secret',
  });
  async function issue(tenant, user, role, permission, securityVersion) {
    const issued = await sessionService.issue({ tenantId: id(tenant), userId: id(user), roles: [role], permissions: [permission],
      securityVersion, providerIdentity: { provider: 'test_identity', reference: `synthetic-${user}` } }, { correlationId: id(99) });
    return { ...issued, cookie: issued.setCookie.split(';', 1)[0] };
  }
  const manager = await issue(1, 3, 'conference_manager', 'tenant:catalogue:manage', 2);
  const technicalAdmin = await issue(1, 4, 'tenant_admin', 'tenant:integrations:manage', 1);
  const foreignManager = await issue(2, 5, 'conference_manager', 'tenant:catalogue:manage', 1);
  const tenantRepository = createPostgresTenantRepository(pool, { auditRepository });
  const server = createHttpServer({ config, authorizationPolicy, auditService, sessionService,
    loadTenant: (tenant) => tenantRepository.findById(tenant),
    additionalRouteModules: createCateringConfigurationRouteModules({ config, persistence: { pool, auditRepository },
      authorizationPolicy, auditService }),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const assignmentPath = '/api/v1/tenant/catering/catalogue-assignments';
  const connectionsPath = '/api/v1/tenant/catering/catalogue-connections';
  const commandBody = { schemaVersion: 1, expectedRevision: 3, catalogueRevision: 3, assignments: assignments() };
  const exchange = ({ actor, path = assignmentPath, method = 'GET', csrf, requestOrigin = origin, body } = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        Host: new URL(origin).host, Origin: requestOrigin,
        ...(actor ? { Cookie: actor.cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    assert.equal((await exchange()).status, 401);
    assert.equal((await exchange({ actor: manager })).status, 200);
    const available = await exchange({ actor: manager, path: connectionsPath });
    assert.equal(available.status, 200);
    assert.deepEqual(Object.keys(available.body.connections[0]).sort(), ['integrationId', 'providerId']);
    assert.equal((await exchange({ actor: technicalAdmin })).status, 403);
    assert.equal((await exchange({ actor: manager, path: '/api/v1/integrations/catering' })).status, 403);
    assert.equal((await exchange({ actor: foreignManager })).body.revision, 0);
    for (const options of [{}, { csrf: technicalAdmin.csrfToken }, { csrf: 'x'.repeat(43) },
      { csrf: manager.csrfToken, requestOrigin: 'https://foreign.invalid' }]) {
      assert.equal((await exchange({ actor: manager, method: 'PUT', body: commandBody, ...options })).status, 403);
    }
    const updated = await exchange({ actor: manager, method: 'PUT', csrf: manager.csrfToken, body: commandBody });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.revision, 4);
    assert.equal(updated.body.stale, false);
    assert.equal((await exchange({ actor: manager, method: 'PUT', csrf: manager.csrfToken, body: commandBody })).status, 409);
    assert.equal((await exchange({ actor: foreignManager, method: 'PUT', csrf: foreignManager.csrfToken,
      body: { ...commandBody, expectedRevision: 0, catalogueRevision: 2 } })).status, 400);
    await sessionService.revoke(manager.principal, { correlationId: id(99) });
    assert.equal((await exchange({ actor: manager })).status, 401);
    assert.equal(await auditRepository.verifyTenantChain(id(1)), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  await seedTenant(30, 31, 32);
  await seedSession(30, 31, 33, 'conference_manager', 'tenant:catalogue:manage');
  await seedSession(30, 32, 34, 'tenant_admin', 'tenant:integrations:manage');
  assert.equal((await service.replace({ ...context(30, 31, 33), schemaVersion: 1, expectedRevision: 0,
    catalogueRevision: 1, assignments: [] })).revision, 1);
  assert.equal(await count('integrations', 30), 0);
  await seedConnection(30, 32, 34, 35);
  const full = { ...empty(), cateringItems: Array.from({ length: 300 }, (_, i) => entity(`item-${i}`)),
    cateringPackages: Array.from({ length: 100 }, (_, i) => entity(`package-${i}`, {
      itemIds: i === 0 ? Array.from({ length: 300 }, (_, item) => `item-${item}`) : ['item-0'], variants: [],
    })) };
  await catalogueService.update({ ...context(30, 31, 33), schemaVersion: 1, expectedRevision: 1, catalogue: full });
  const fullAssignments = [
    ...full.cateringItems.map((entry) => ({ kind: 'item', entryId: entry.id, integrationId: id(35) })),
    ...full.cateringPackages.map((entry) => ({ kind: 'package', entryId: entry.id, integrationId: id(35) })),
  ];
  assert.equal((await service.replace({ ...context(30, 31, 33), schemaVersion: 1, expectedRevision: 1,
    catalogueRevision: 2, assignments: fullAssignments })).assignments.length, 400);
  assert.equal(await count('catering_catalogue_assignment_seals', 30), 2);
  assert.equal(await auditRepository.verifyTenantChain(id(30)), true);
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
  assert.equal(await rollbackLatest(pool), true); // Remove empty delivery schema049 before the older rollback probe.
  assert.equal(await rollbackLatest(pool), true); // Remove empty order foreign keys before clearing assignment history.
  await pool.query(`TRUNCATE catering_catalogue_assignment_heads,catering_catalogue_assignment_entries,
    catering_catalogue_assignment_seals,catering_catalogue_assignment_revisions`);
  assert.equal(await rollbackLatest(pool), true);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});

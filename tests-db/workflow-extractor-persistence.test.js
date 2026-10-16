import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createAuditService } from '../src/audit/audit-service.js';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createProductionApplicationService } from '../src/application/production-application-service.js';
import { createRequestService } from '../src/application/request-service.js';
import { createWorkflowExtractor } from '../scripts/support/workflow-extractor.mjs';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';

test('operator extraction reuses real HMAC audit reads and manager revisions without crossing Tenants', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), DATABASE_SSL: 'disable',
    ENTRA_CLIENT_ID: randomUUID(), ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'),
    OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') });
  const persistence = createPostgresPersistence(config); t.after(() => persistence.close());
  await migrateUp(persistence.pool);
  const tenants = [randomUUID(), randomUUID()]; const users = [randomUUID(), randomUUID()];
  for (let index = 0; index < tenants.length; index += 1) {
    await persistence.pool.query('INSERT INTO tenants(id,display_name,status) VALUES($1,$2,\'active\')',
      [tenants[index], 'Synthetic extractor Tenant']);
    await persistence.pool.query('INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,$3)',
      [tenants[index], users[index], 'PRIVATE synthetic actor']);
    await persistence.pool.query(`INSERT INTO sites(tenant_id,id,name,time_zone)
      VALUES($1,'site','Synthetic site','Europe/Berlin')`, [tenants[index]]);
    await persistence.pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
      VALUES($1,'room','site','Synthetic room',20)`, [tenants[index]]);
    await persistence.pool.query(`INSERT INTO tenant_room_prices(tenant_id,room_id,price_minor,currency,created_at,updated_at)
      VALUES($1,'room',$2,'EUR',transaction_timestamp(),transaction_timestamp())`, [tenants[index], 1000 + index]);
  }
  const authorizationPolicy = createAuthorizationPolicy();
  const observed = Date.parse('2026-10-16T12:00:00.000Z'); let now = Date.parse('2026-10-02T10:00:00.000Z');
  const clock = () => now; const targetId = randomUUID();
  const auditService = createAuditService({ repository: persistence.auditRepository, authorizationPolicy, clock });
  const application = createProductionApplicationService({ repository: persistence.applicationRepository,
    requestRepository: persistence.requestRepository, authorizationPolicy, auditService, clock, idFactory: () => targetId });
  const requestService = createRequestService({ repository: persistence.requestRepository,
    authorizationPolicy, auditService, clock,
    finalRoomConfirmationService: { async confirm() { throw new Error('UNEXPECTED_PROVIDER_WORK'); } } });
  const principals = tenants.map((tenantId, index) => ({ tenantId, userId: users[index],
    ...tenantAuthorizationSnapshot(['employee', 'tenant_admin', 'conference_manager']) }));
  for (let index = 0; index < tenants.length; index += 1) {
    const principal = principals[index]; const tenantContext = { tenantId: principal.tenantId, status: 'active' };
    const catalog = await persistence.applicationRepository.loadCatalogPage({ tenantId: principal.tenantId,
      section: 'sites', limit: 1 });
    const created = await application.createRequest({ principal, tenantContext, correlationId: randomUUID(),
      schemaVersion: 3, requestDraft: requestLoadDraft({ configurationRevisions: catalog.configurationRevisions }) });
    assert.equal(created.id, targetId); now += 1000;
    await requestService.transitionRequest({ principal, tenantContext, correlationId: randomUUID(),
      requestId: targetId, expectedVersion: 1, transition: 'start_review' }); now += 1000;
    await requestService.transitionRequest({ principal, tenantContext, correlationId: randomUUID(),
      requestId: targetId, expectedVersion: 2, transition: 'reject', reason: 'Synthetic decision' }); now += 1000;
  }
  now = observed;
  const tenantAuditQueryService = createTenantAuditQueryService({
    queryRepository: persistence.tenantAuditQueryRepository, integrityRepository: persistence.auditRepository,
    authorizationPolicy, auditService, clock });
  // The test's disposable database instance is its authoritative immutable epoch.
  // Real resettable sources must supply their actual durable epoch via this port.
  const sourceEpoch = url.pathname.slice(1);
  const extractor = createWorkflowExtractor({ tenantAuditQueryService, requestService, authorizationPolicy,
    platformAuditService: { async list() { throw new Error('UNEXPECTED_PLATFORM_READ'); } },
    platformAuthorizationPolicy: { async authorize() { return false; } },
    sourceEpoch, readSourceEpoch: async () => sourceEpoch, environment: 'demo', clock });
  const outputs = [];
  for (const principal of principals) {
    const result = await extractor.collectTenant({ principal, correlationId: randomUUID(),
      tenantContext: { tenantId: principal.tenantId, status: 'active' } });
    assert.deepEqual(result.productEvents.map(x => x.kind).sort(), ['manager_decision', 'request_submitted']);
    assert.ok(result.productEvents.every(x => x.tenantId === principal.tenantId && x.targetId === targetId));
    assert.equal(result.productComplete, false); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(await persistence.auditRepository.verifyTenantChain(principal.tenantId), true); outputs.push(result);
  }
  assert.notEqual(outputs[0].productEvents[0].sourceId, outputs[1].productEvents[0].sourceId);
  await assert.rejects(extractor.collectTenant({ principal: principals[0], correlationId: randomUUID(),
    tenantContext: { tenantId: tenants[1], status: 'active' } }), /WORKFLOW_EXTRACTION_FAILED/);
  await persistence.pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await persistence.pool.query('UPDATE audit_events SET target_id=$1 WHERE tenant_id=$2 AND action=$3',
      [randomUUID(), tenants[0], 'request.created']);
  } finally { await persistence.pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only'); }
  await assert.rejects(extractor.collectTenant({ principal: principals[0], correlationId: randomUUID(),
    tenantContext: { tenantId: tenants[0], status: 'active' } }), /^Error: WORKFLOW_EXTRACTION_FAILED$/);
});

import { createCateringCatalogueAssignmentService } from '../../src/application/catering-catalogue-assignment-service.js';
import { createCateringOrderService } from '../../src/application/catering-order-service.js';
import { createTenantCatalogueService } from '../../src/application/tenant-catalogue-service.js';
import { createAuditService } from '../../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../../src/authorization/policy.js';
import { createSessionService } from '../../src/identity/session-service.js';
import { createCateringConfigurationRegistry } from '../../src/integrations/catering-provider-registration.js';
import { createPostgresAuditRepository } from '../../src/persistence/postgres/audit-repository.js';
import {
  createPostgresCateringCatalogueAssignmentRepository,
} from '../../src/persistence/postgres/catering-catalogue-assignment-repository.js';
import { createPostgresCateringConfigurationRepository } from '../../src/persistence/postgres/catering-configuration-repository.js';
import { createPostgresCateringOrderRepository } from '../../src/persistence/postgres/catering-order-repository.js';
import { appendRequestRevisionWithClient } from '../../src/persistence/postgres/request-repository.js';
import { createPostgresSessionRepository } from '../../src/persistence/postgres/session-repository.js';
import { createPostgresTenantCatalogueRepository } from '../../src/persistence/postgres/tenant-catalogue-repository.js';
import { withPostgresTransaction } from '../../src/persistence/postgres/transaction.js';
import { cateringId as id, cateringOrderFixture } from '../../tests/support/catering-order-fixture.js';

// Real application/session/audit preparation. Only the future Confirmed Request
// is controlled SQL test setup; no supplier, calendar or live order is created.
export async function createCateringDeliveryFixture(pool, { registry = createCateringConfigurationRegistry(), extraCount = 0 } = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'a'.repeat(32) });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const sessionService = createSessionService({ repository: createPostgresSessionRepository(pool, { auditRepository }),
    auditService, publicOrigin: 'http://localhost:3000', csrfSecret: 'c'.repeat(32) });
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Synthetic Delivery Tenant','active')", [id(1)]);
  for (const user of [2,20,30]) await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Synthetic User')",
    [id(1), id(user)]);
  await pool.query("INSERT INTO sites(tenant_id,id,name,time_zone) VALUES ($1,'site-a','Synthetic Site','Europe/Berlin')", [id(1)]);
  await pool.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity) VALUES ($1,'room-a','site-a','Synthetic Room',500)", [id(1)]);
  async function issue(userId, role, permissions) {
    return sessionService.issue({ tenantId: id(1), userId, roles: [role], permissions, securityVersion: 1,
      providerIdentity: { provider: 'test_identity', reference: `synthetic-${userId}` } }, { correlationId: id(90) });
  }
  const manager = await issue(id(20), 'conference_manager', ['request:manage','tenant:catalogue:manage']);
  const admin = await issue(id(30), 'tenant_admin', ['tenant:integrations:manage']);
  const context = (actor = manager) => ({ principal: actor.principal,
    tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(90) });
  await pool.query(`INSERT INTO integrations(tenant_id,id,provider,provider_reference,status)
    VALUES ($1,$2,'manual_catering','synthetic-delivery-source','configured')`, [id(1), id(3)]);
  const configuration = createPostgresCateringConfigurationRepository(pool, { registry, auditRepository });
  function configurationCommand(expectedRevision, enabled = true, mode = 'manual') {
    return { tenantId: id(1), integrationId: id(3), providerId: 'manual_catering',
      actorUserId: id(30), sessionId: admin.principal.session.id, expectedSecurityVersion: 1,
      expectedRevision, changedAt: new Date(), correlationId: id(90),
      configuration: { initialOrderMode: 'manager_review', capabilities: enabled ? {
        'catering.order': mode, ...(mode === 'api' ? { 'catering.status': 'api' } : {}),
      } : {} },
      auditEventFor({ revision }) { return auditService.createEvent({ ...context(admin), action: 'tenant.configuration.changed',
        targetType: 'integration', targetId: id(3), previousState: { revision: expectedRevision }, newState: { revision },
        outcome: 'success', retentionClass: 'administrative', metadata: {
          operation: expectedRevision === 0 ? 'catering_configuration_initialize' : 'catering_configuration_update',
        } }); },
    };
  }
  await configuration.initialize(configurationCommand(0));
  let configurationRevision = 1;
  async function setOrderCapability(enabled, mode = 'manual') {
    const saved = await configuration.update(configurationCommand(configurationRevision, enabled, mode));
    if (saved.status !== 'updated') throw new Error('SYNTHETIC_CONFIGURATION_UPDATE_FAILED');
    configurationRevision++;
  }
  const source = (sequence) => cateringOrderFixture({ requestVersion: 1, catalogueRevision: 2,
    extraCount, includedSelection: false, capturedAt: new Date(Date.now() - 3600000).toISOString(),
    startsAt: new Date(Date.now() + 172800000 + sequence * 7200000).toISOString() });
  const catalogue = createTenantCatalogueService({ authorizationPolicy, auditService,
    repository: createPostgresTenantCatalogueRepository(pool, { auditRepository }) });
  await catalogue.update({ ...context(), schemaVersion: 1, expectedRevision: 1, catalogue: source(0).canonicalCatalogue });
  const assignments = createCateringCatalogueAssignmentService({ authorizationPolicy, auditService,
    repository: createPostgresCateringCatalogueAssignmentRepository(pool, { registry, auditRepository }) });
  await assignments.replace({ ...context(), schemaVersion: 1, expectedRevision: 0, catalogueRevision: 2,
    assignments: source(0).ownership.assignments });
  const orders = createCateringOrderService({ authorizationPolicy, auditService, registry,
    repository: createPostgresCateringOrderRepository(pool, { registry, auditRepository }) });
  async function createApprovedOrder(sequence = 0, { quoteExpiresAt = new Date(Date.now() + 3600000).toISOString() } = {}) {
    const request = { ...source(sequence).request, id: `request-delivery-${sequence}` };
    const event = auditService.createEvent({ principal: { tenantId: id(1), userId: id(2) },
      tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(90), action: 'request.created',
      targetType: 'request', targetId: request.id, newState: { status: 'Confirmed', version: 1 },
      outcome: 'success', retentionClass: 'business' });
    await withPostgresTransaction(pool, async (client) => {
      await client.query(`INSERT INTO requests(tenant_id,id,requester_user_id,room_id,status,starts_at,ends_at,
        internal_participants,external_participants,schema_version,request_version,request_snapshot,
        status_changed_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [request.tenantId, request.id, request.requesterUserId, request.roomId, request.status, request.startsAt, request.endsAt,
        request.internalParticipants, request.externalParticipants, request.schemaVersion, request.version,
        JSON.stringify(request.snapshot),
        request.statusChangedAt, request.createdAt, request.updatedAt]);
      await appendRequestRevisionWithClient(client, request, 'created', event, 'employee');
      await auditRepository.appendWithClient(client, event);
    });
    const prepared = await orders.prepare({ ...context(), schemaVersion: 1, requestId: request.id, commandId: id(100 + sequence),
      expectedRequestVersion: 1, expectedAssignmentRevision: 1 });
    const orderId = prepared.orders[0].orderId;
    await orders.recordQuote({ ...context(), schemaVersion: 1, orderId, expectedStateRevision: 1, expectedQuoteRevision: 0,
      cost: { amountMinor: 1200, currency: 'EUR' }, expiresAt: quoteExpiresAt });
    return orders.decide({ ...context(), schemaVersion: 1, orderId, expectedStateRevision: 2, expectedQuoteRevision: 1,
      decision: 'approved' });
  }
  return Object.freeze({ registry, auditRepository, auditService, sessionService, manager, admin, context,
    createApprovedOrder, setOrderCapability, orders, tenantId: id(1), integrationId: id(3) });
}

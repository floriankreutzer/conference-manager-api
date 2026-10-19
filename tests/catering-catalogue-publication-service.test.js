import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringCataloguePublicationService } from '../src/application/catering-catalogue-publication-service.js';
import { normalizeCateringCatalogueReviewCommand } from '../src/domain/catering-catalogue-publication.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const time = '2026-10-19T12:00:00.000Z';
const context = () => ({ principal: { tenantId: id(1),userId: id(20),roles: ['conference_manager'],
  permissions: ['tenant:catalogue:manage'],session: { id: id(40),securityVersion: 1 } },
  tenantContext: { tenantId: id(1),status: 'active' },integrationId: id(3),correlationId: id(90) });
const command = () => ({ schemaVersion: 1,commandId: id(100),expectedReviewRevision: 0,expectedSourceRevision: 1,
  expectedConfigurationRevision: 3,expectedCatalogueRevision: 4,expectedAssignmentRevision: 0,expectedPublicationRevision: 0,
  decision: 'published',justification: 'Synthetic explicit Manager review of received content and costs',
  items: [{ sourceId: 'supplier-coffee',entryId: 'our-coffee',price: { amountMinor: 700,currency: 'EUR' },
    active: true,order: 0,siteIds: [],roomIds: [] }],packages: [] });
const state = () => ({ tenantId: id(1),integrationId: id(3),sourceRevision: 1,configurationRevision: 3,
  catalogueRevision: 4,assignmentRevision: 0,publicationRevision: 0,
  source: { schemaVersion: 1,sourceVersion: 'synthetic-source',items: [{ id: 'supplier-coffee',name: 'Synthetic supplier coffee',
    description: null,providerPrice: { amountMinor: 250,currency: 'EUR' } }],packages: [],
  terms: { minimumLeadTimeMinutes: null,minimumOrderValue: null,changeCutoffMinutes: null,cancelCutoffMinutes: null } },
  catalogue: { services: [],equipment: [],cateringItems: [],cateringPackages: [],roomPrices: [] },assignments: [],
  connections: [{ tenantId: id(1),integrationId: id(3) }],previousBindings: [] });
function fixture({ status = 'reviewed',kind = 'source',replayed = false,changedReceipt = (value) => value,
  changedState = (value) => value } = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy }); const calls = [];
  const repository = { async review(input) {
    calls.push(input); if (status !== 'reviewed') return { status,...(status === 'conflict' ? { kind } : {}) };
    const increment = input.command.decision === 'published' ? 1 : 0;
    const counters = { reviewRevision: input.command.expectedReviewRevision+1,
      publicationRevision: input.command.expectedPublicationRevision+increment,
      catalogueRevision: input.command.expectedCatalogueRevision+increment,
      assignmentRevision: input.command.expectedAssignmentRevision+increment };
    if (!replayed) {
      if (input.command.decision === 'published') {
        const previous = changedState(state()); const plan = input.planFor(previous);
        calls.push({ plan });
        audit.events.push(input.catalogueAuditFor({ previous: previous.catalogue,next: plan.catalogue,
          nextRevision: plan.catalogueRevision }));
        audit.events.push(input.assignmentAuditFor({ revision: plan.assignmentRevision,catalogueRevision: plan.catalogueRevision }));
      }
      audit.events.push(input.reviewAuditFor(counters));
    }
    return { status,replayed,receipt: changedReceipt({ tenantId: input.tenantId,integrationId: input.integrationId,
      actorUserId: input.actorUserId,actorSecurityVersion: input.expectedSecurityVersion,command: input.command,
      ...counters,recordedAt: time }) };
  } };
  return { calls,audit,service: createCateringCataloguePublicationService({ repository,authorizationPolicy,auditService: audit.service }) };
}

test('Catalogue-only Manager publication binds exact versions and emits three minimized transactional audit factories',async () => {
  const f = fixture(); const result = await f.service.review({ ...context(),command: command() });
  assert.deepEqual(result,{ schemaVersion: 1,commandId: id(100),decision: 'published',replayed: false,
    reviewRevision: 1,publicationRevision: 1,catalogueRevision: 5,assignmentRevision: 1,recordedAt: time });
  assert.equal(f.calls[0].tenantId,id(1)); assert.equal(f.calls[0].sessionId,id(40)); assert.equal(f.calls[0].expectedSecurityVersion,1);
  assert.equal(Object.isFrozen(f.calls[0].command.items[0].price),true);
  assert.equal(f.calls[1].plan.catalogue.cateringItems[0].price.amountMinor,700);
  assert.equal(f.audit.events.length,3);
  assert.deepEqual(f.audit.events.map((entry) => entry.action),
    ['tenant.configuration.changed','tenant.configuration.changed','catering.catalogue.published']);
  assert.equal(f.audit.events[0].targetType,'catalogue'); assert.equal(f.audit.events[0].targetId,'tenant-catalogue');
  assert.deepEqual(f.audit.events[1].newState,{ catalogueRevision: 5,revision: 1 });
  assert.doesNotMatch(JSON.stringify(f.audit.events),/providerPrice|700|250|supplier-coffee|justification|Synthetic explicit/);
  assert.doesNotMatch(JSON.stringify(result),/tenantId|integrationId|actorUserId|sessionId|price|justification/);
});

test('rejected content keeps publication/catalogue/assignment unchanged and never invokes a replacement planner',async () => {
  const f = fixture();
  const intent = { ...command(),decision: 'rejected',items: [],expectedPublicationRevision: 2,expectedAssignmentRevision: 3 };
  const result = await f.service.review({ ...context(),command: intent });
  assert.equal(result.reviewRevision,1); assert.equal(result.publicationRevision,2);
  assert.equal(result.catalogueRevision,4); assert.equal(result.assignmentRevision,3); assert.equal(f.calls.length,1);
  assert.deepEqual(f.audit.events.map((entry) => entry.action),['catering.catalogue.rejected']);
  assert.deepEqual(f.audit.events[0].newState,{ revision: 1 });
  assert.throws(() => normalizeCateringCatalogueReviewCommand({ ...command(),decision: 'rejected' }),/INVALID/);
});

test('historical review replay validates exact intent without rebuilding later state or emitting duplicate audit',async () => {
  const f = fixture({ replayed: true,changedState() { throw new Error('MUST_NOT_REPLAN'); } });
  assert.equal((await f.service.review({ ...context(),command: command() })).replayed,true);
  assert.equal(f.calls.length,1); assert.equal(f.audit.events.length,0);
  const bad = fixture({ replayed: true,
    changedReceipt(value) { return { ...value,command: { ...value.command,justification: 'altered' } }; } });
  await assert.rejects(bad.service.review({ ...context(),command: command() }),/RESULT_INVALID/);
});

test('Employee, Admin alone, Platform, missing permission and foreign Tenant cannot reach publication ports',async () => {
  for (const principal of [ { ...context().principal,roles: ['employee'] },{ ...context().principal,roles: ['tenant_admin'] },
    { ...context().principal,roles: ['platform_admin'] },{ ...context().principal,permissions: [] },
    { ...context().principal,tenantId: id(9) } ]) {
    const f = fixture(); await assert.rejects(f.service.review({ ...context(),principal,command: command() }));
    assert.equal(f.calls.length,0);
  }
  for (const changes of [{ principal: { ...context().principal,session: null } },
    { tenantContext: { tenantId: id(1),status: 'suspended' } }]) {
    const f = fixture(); await assert.rejects(f.service.review({ ...context(),...changes,command: command() }));
    assert.equal(f.calls.length,0);
  }
});

test('closed review rejects hidden authority, ambiguous rejection, unsafe justification and impossible versions',async () => {
  for (const change of [{ decision: 'approved' },{ decision: 'rejected' },{ justification: '' },{ justification: 'x\u0085control' },
    { justification: '<unsafe>' },{ expectedReviewRevision: Number.MAX_SAFE_INTEGER },{ published: true },{ tenantId: id(9) }]) {
    const f = fixture(); await assert.rejects(f.service.review({ ...context(),command: { ...command(),...change } }),/INPUT_INVALID/);
    assert.equal(f.calls.length,0);
  }
  let reads = 0; const intent = command();
  Object.defineProperty(intent,'decision',{ enumerable: true,get() { reads++; return 'published'; } });
  await assert.rejects(fixture().service.review({ ...context(),command: intent }),/INPUT_INVALID/); assert.equal(reads,0);
});

test('every live CAS/command/reference conflict is closed without an acknowledgement, retry or audit-success callback',async () => {
  for (const kind of ['source','configuration','catalogue','assignment','review','publication','command','connection','reference']) {
    const f = fixture({ status: 'conflict',kind });
    await assert.rejects(f.service.review({ ...context(),command: command() }),
      (error) => error.code === `CATERING_CATALOGUE_PUBLICATION_${kind.toUpperCase()}_CONFLICT`
        && asApiError(error).statusCode === 409);
    assert.equal(f.calls.length,1); assert.equal(f.audit.events.length,0);
  }
  const revoked = fixture({ status: 'not_authorized' });
  await assert.rejects(revoked.service.review({ ...context(),command: command() }),/PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal(revoked.audit.events[0].action,'authorization.denied');
  await assert.rejects(fixture({ status: 'not_found' }).service.review({ ...context(),command: command() }),
    (error) => error.code === 'RESOURCE_NOT_AVAILABLE' && error.conceal === true);
});

test('corrupt private scope, altered commercial intent or acknowledgement counters never become a publication success',async () => {
  for (const change of [{ tenantId: id(9) },{ integrationId: id(9) },{ actorUserId: id(9) },{ actorSecurityVersion: 2 },
    { reviewRevision: 2 },{ publicationRevision: 0 },{ catalogueRevision: 4 },{ assignmentRevision: 0 },{ recordedAt: 'invalid' },
    { credential: 'not-permitted' }]) {
    const f = fixture({ replayed: true,changedReceipt: (value) => ({ ...value,...change }) });
    await assert.rejects(f.service.review({ ...context(),command: command() }),/RESULT_INVALID/);
  }
  for (const change of [{ tenantId: id(9) },{ integrationId: id(9) },{ sourceRevision: 2 }]) {
    const f = fixture({ changedState: (value) => ({ ...value,...change }) });
    await assert.rejects(f.service.review({ ...context(),command: command() })); assert.equal(f.audit.events.length,0);
  }
});

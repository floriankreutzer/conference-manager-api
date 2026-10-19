import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringCataloguePublicationReadService } from '../src/application/catering-catalogue-publication-read-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const context = () => ({ principal: { tenantId: id(1),userId: id(20),roles: ['conference_manager'],
  permissions: ['tenant:catalogue:manage'] },tenantContext: { tenantId: id(1),status: 'active' },
  integrationId: id(3),correlationId: id(90) });
const binding = (entryId = 'a') => ({ kind: 'item',entryId,sourceId: `supplier-${entryId}`,variants: [] });
const row = () => ({ tenantId: id(1),integrationId: id(3),providerId: 'manual_catering',configurationRevision: 2,
  configuration: { initialOrderMode: 'manager_review',capabilities: { 'catering.catalogue': 'manual' } },connectionAvailable: true,
  sourceRevision: 3,reviewRevision: 2,publicationRevision: 1,publishedSourceRevision: 1,catalogueRevision: 4,catalogueEmpty: false,
  assignmentRevision: 2,assignmentReady: true,bindings: [] });
const historical = (revision) => ({ revision,sourceRevision: 1,configurationRevision: 1,catalogueRevision: 4,assignmentRevision: 2,
  publicationRevision: 1,decision: revision === 1 ? 'published' : 'rejected',
  justification: 'Synthetic explicit review rationale',recordedAt: '2026-10-19T12:00:00.000Z' });
function fixture({ selected = row(),history = { tenantId: id(1),integrationId: id(3),reviewRevision: 0,revisions: [] },
  maxResponseBytes = 524288 } = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy }); const calls = [];
  return { calls,audit,service: createCateringCataloguePublicationReadService({ registry: createCateringConfigurationRegistry(),
    authorizationPolicy,auditService: audit.service,maxResponseBytes,repository: {
      async loadContext(input) { calls.push(input); return selected; },async listHistory(input) { calls.push(input); return history; },
    } }) };
}

test('Manager review context has bounded immutable publication bindings, explicit observed versions and no private authority',async () => {
  const f = fixture({ selected: { ...row(),bindings: ['a','b','c','d','e','f'].map(binding) } });
  const value = await f.service.loadContext(context());
  assert.equal(value.canReview,true); assert.equal(value.bindings.length,5);
  assert.deepEqual(value.nextAfterBinding,{ kind: 'item',entryId: 'e' });
  assert.equal(Object.isFrozen(value.bindings[0].variants),true);
  assert.deepEqual(f.calls[0],{ tenantId: id(1),integrationId: id(3),afterBinding: null });
  assert.doesNotMatch(JSON.stringify(value),/tenantId|actorUserId|session|credential|configuration"|providerPrice|assignmentReady/);
  for (const extra of [{ connectionAvailable: false },{ assignmentReady: false },
    { configuration: { initialOrderMode: 'manager_review',capabilities: {} } }]) {
    assert.equal((await fixture({ selected: { ...row(),...extra } }).service.loadContext(context())).canReview,false);
  }
  const empty = { ...row(),sourceRevision: 0,reviewRevision: 0,publicationRevision: 0,publishedSourceRevision: 0,
    assignmentRevision: 0,catalogueEmpty: true };
  assert.equal((await fixture({ selected: empty }).service.loadContext(context())).canReview,false);
});
test('binding keyset requires a publication version and refuses stale or malformed cursors before disclosure',async () => {
  const f = fixture({ selected: { ...row(),bindings: [binding('z')] } });
  assert.equal((await f.service.loadContext({ ...context(),afterBinding: { kind: 'item',entryId: 'e' },publicationRevision: 1 }))
    .bindings[0].entryId,'z');
  await assert.rejects(f.service.loadContext({ ...context(),publicationRevision: 0 }),
    (error) => error.code.endsWith('PUBLICATION_CONFLICT'));
  for (const extra of [{ afterBinding: { kind: 'item',entryId: 'a' } },{ publicationRevision: -1 },
    { afterBinding: { kind: 'foreign',entryId: 'a' },publicationRevision: 1 },
    { afterBinding: { kind: 'item',entryId: '../a' },publicationRevision: 1 }]) {
    const before = f.calls.length; await assert.rejects(f.service.loadContext({ ...context(),...extra }),/INPUT_INVALID/);
    assert.equal(f.calls.length,before);
  }
});
test('corrupt private context, impossible counters, sixth bindings, hidden getters and foreign scope fail closed',async () => {
  for (const extra of [{ tenantId: id(99) },{ integrationId: id(99) },{ providerId: 'foreign' },{ credential: 'private' },
    { publicationRevision: 3 },{ publishedSourceRevision: 4 },{ assignmentReady: 'yes' },{ sourceRevision: 0 },
    { publicationRevision: 0 },{ bindings: [binding('b'),binding('a')] },
    { bindings: [binding(),{ ...binding(),entryId: 'b',variants: [{ entryId: 'x',sourceId: 'x' }] }] },
    { bindings: ['a','b','c','d','e'].map(binding).concat({ ...binding('f'),private: true }) }]) {
    await assert.rejects(fixture({ selected: { ...row(),...extra } }).service.loadContext(context()));
  }
  let reads = 0; const selected = row();
  Object.defineProperty(selected,'bindings',{ enumerable: true,get() { reads++; return []; } });
  await assert.rejects(fixture({ selected }).service.loadContext(context())); assert.equal(reads,0);
  await assert.rejects(fixture({ selected: null }).service.loadContext(context()),
    (error) => error.code === 'RESOURCE_NOT_AVAILABLE' && error.conceal === true);
});
test('Employee, Admin alone, missing Catalogue permission and foreign Principal cannot reach read repositories',async () => {
  for (const principal of [{ ...context().principal,roles: ['employee'] },{ ...context().principal,roles: ['tenant_admin'] },
    { ...context().principal,permissions: [] },{ ...context().principal,tenantId: id(99) }]) {
    const f = fixture(); await assert.rejects(f.service.loadContext({ ...context(),principal }));
    await assert.rejects(f.service.listHistory({ ...context(),principal })); assert.equal(f.calls.length,0);
  }
  const f = fixture(); await assert.rejects(f.service.loadContext({ ...context(),tenantContext: { tenantId: id(1),status: 'suspended' } }));
  assert.equal(f.calls.length,0);
});
test('review history validates contiguous21-record metadata before exposing20 and distinguishes actual end of history',async () => {
  const history = { tenantId: id(1),integrationId: id(3),reviewRevision: 22,
    revisions: Array.from({ length: 21 },(_,i) => historical(22-i)) };
  const f = fixture({ history }); const value = await f.service.listHistory(context());
  assert.equal(value.revisions.length,20); assert.equal(value.nextBeforeRevision,3);
  assert.equal(value.revisions[0].justification,historical(22).justification);
  assert.doesNotMatch(JSON.stringify(value),/actorUserId|tenantId|session|price|commandId/);
  const last = fixture({ history: { ...history,revisions: [historical(2),historical(1)] } });
  assert.equal((await last.service.listHistory({ ...context(),beforeRevision: 3 })).nextBeforeRevision,null);
  for (const changed of [{ ...history,revisions: history.revisions.slice(1) },
    { ...history,revisions: history.revisions.slice(0,20) },{ ...history,revisions: [historical(22)] },
    { ...history,revisions: [...history.revisions.slice(0,20),{ ...historical(2),private: true }] }]) {
    await assert.rejects(fixture({ history: changed }).service.listHistory(context()));
  }
  assert.equal((await fixture().service.listHistory(context())).revisions.length,0);
});
test('history refuses malformed and foreign results, unsafe rationale, impossible publication and ambiguous cursors',async () => {
  const base = { tenantId: id(1),integrationId: id(3),reviewRevision: 1,revisions: [historical(1)] };
  for (const extra of [{ tenantId: id(99) },{ integrationId: id(99) },{ private: true },
    { revisions: [{ ...historical(1),decision: 'approved' }] },{ revisions: [{ ...historical(1),justification: '<unsafe>' }] },
    { revisions: [{ ...historical(1),justification: 'unsafe\u0085control' }] },
    { revisions: [{ ...historical(1),recordedAt: 'invalid' }] },{ revisions: [{ ...historical(1),publicationRevision: 2 }] }]) {
    await assert.rejects(fixture({ history: { ...base,...extra } }).service.listHistory(context()));
  }
  for (const beforeRevision of [0,-1,1.5,Number.MAX_SAFE_INTEGER]) {
    const f = fixture(); await assert.rejects(f.service.listHistory({ ...context(),beforeRevision }),/INPUT_INVALID/);
    assert.equal(f.calls.length,0);
  }
  await assert.rejects(fixture().service.listHistory({ ...context(),beforeRevision: 2 }),/INPUT_INVALID/);
});


test('UTF-8 packing keeps every review rationale and binding reachable without empty or false final pages',async () => {
  const revisions = Array.from({ length: 22 },(_,i) => ({ ...historical(22-i),justification: 'ä'.repeat(500) }));
  let beforeRevision = null; const observed = [];
  do {
    const history = { tenantId: id(1),integrationId: id(3),reviewRevision: 22,
      revisions: revisions.filter((x) => beforeRevision === null || x.revision<beforeRevision).slice(0,21) };
    const f = fixture({ history,maxResponseBytes: 4096 });
    const page = await f.service.listHistory({ ...context(),beforeRevision });
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096); assert.ok(page.revisions.length>0);
    observed.push(...page.revisions.map((x) => x.revision)); beforeRevision=page.nextBeforeRevision;
  } while (beforeRevision !== null);
  assert.deepEqual(observed,Array.from({ length: 22 },(_,i) => 22-i));
  const bindings = Array.from({ length: 12 },(_,i) => binding(`entry-${String(i).padStart(2,'0')}-${'a'.repeat(100)}`));
  let afterBinding = null; const ids = [];
  do {
    const selected = { ...row(),bindings: bindings.filter((x) => afterBinding === null || x.entryId>afterBinding.entryId).slice(0,6) };
    const reader = fixture({ selected,maxResponseBytes: 1024 }).service;
    const page = await reader.loadContext({ ...context(),afterBinding,publicationRevision: 1 });
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=1024); assert.ok(page.bindings.length>0);
    ids.push(...page.bindings.map((x) => x.entryId)); afterBinding=page.nextAfterBinding;
  } while (afterBinding !== null);
  assert.deepEqual(ids,bindings.map((x) => x.entryId));
  await assert.rejects(fixture({ history: { tenantId: id(1),integrationId: id(3),reviewRevision: 1,
    revisions: [{ ...historical(1),justification: 'ä'.repeat(1000) }] },maxResponseBytes: 1024 })
    .service.listHistory(context()),/RESPONSE_TOO_LARGE/);
});

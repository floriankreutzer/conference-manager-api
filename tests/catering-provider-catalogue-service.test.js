import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringProviderCatalogueService } from '../src/application/catering-provider-catalogue-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const time = '2026-10-19T12:00:00.000Z';
const context = () => ({ principal: { tenantId: id(1), userId: id(20), roles: ['conference_manager'],
  permissions: ['tenant:catalogue:manage'], session: { id: id(40), securityVersion: 1 } },
tenantContext: { tenantId: id(1), status: 'active' }, integrationId: id(3), correlationId: id(90) });
const source = () => ({ schemaVersion: 1, sourceVersion: 'synthetic-v1', items: [{ id: 'coffee', name: 'Synthetic coffee',
  description: null, providerPrice: { amountMinor: 250, currency: 'EUR' } }], packages: [],
terms: { minimumLeadTimeMinutes: 120, minimumOrderValue: null, changeCutoffMinutes: null, cancelCutoffMinutes: 60 } });
const summary = () => ({ sourceVersion: source().sourceVersion, itemCount: 1, packageCount: 0, terms: source().terms });
const command = () => ({ schemaVersion: 1, commandId: id(100), expectedRevision: 0, expectedConfigurationRevision: 1,
  reference: 'Synthetic supplier price list', attestReceivedFromSupplier: true, source: source() });
const row = () => ({ tenantId: id(1), integrationId: id(3), providerId: 'manual_catering', configurationRevision: 1,
  configuration: { initialOrderMode: 'manager_review', capabilities: { 'catering.catalogue': 'manual' } },
  connectionAvailable: true, currentRevision: 0, revisions: [], nextBeforeRevision: null });
const stored = () => ({ tenantId: id(1), integrationId: id(3), providerId: 'manual_catering', commandId: id(100),
  revision: 1, configurationRevision: 1, reference: 'Synthetic source', recordedAt: time,
  actorUserId: id(20), actorSecurityVersion: 1, source: source() });
function fixture({ loaded = row(), detail = stored(), connections = [], maxResponseBytes = 262144, status = 'recorded', replayed = false,
  changeReceipt = (value) => value } = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy });
  const calls = [];
  const repository = { async listConnections(input) { calls.push({ operation: 'connections',input }); return connections; },
    async load(input) { calls.push({ operation: 'load', input }); return loaded; },
    async loadRevision(input) { calls.push({ operation: 'detail', input }); return detail; },
    async receive(input) {
      calls.push({ operation: 'receive', input });
      if (status !== 'recorded') return { status };
      const value = { revision: input.command.expectedRevision + 1, configurationRevision: input.command.expectedConfigurationRevision };
      if (!replayed) audit.events.push(input.auditEventFor(value));
      return { status, replayed, receipt: changeReceipt({ tenantId: input.tenantId, integrationId: input.integrationId,
        providerId: 'manual_catering', commandId: input.command.commandId, ...value, reference: input.command.reference,
        recordedAt: time, actorUserId: input.actorUserId, actorSecurityVersion: input.expectedSecurityVersion,
        source: input.command.source }) };
    } };
  return { calls, audit, service: createCateringProviderCatalogueService({ repository, authorizationPolicy,
    registry: createCateringConfigurationRegistry(), auditService: audit.service, maxResponseBytes }) };
}

test('Catalogue Manager receives manual supplier source as pending evidence with independent costs and minimized audit', async () => {
  const f = fixture(); const result = await f.service.receive({ ...context(), command: command() });
  assert.deepEqual(result, { schemaVersion: 1, commandId: id(100), replayed: false,
    revision: 1, configurationRevision: 1, recordedAt: time });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.sessionId, id(40));
  assert.equal(f.calls[0].input.expectedSecurityVersion, 1); assert.equal(f.calls[0].input.integrationId, id(3));
  assert.equal(f.audit.events.length, 1); assert.equal(f.audit.events[0].action, 'catering.catalogue.received');
  assert.doesNotMatch(JSON.stringify(f.audit.events), /Synthetic supplier|Synthetic coffee|amountMinor|reference|sourceVersion/);
  assert.equal(Object.hasOwn(result, 'published'), false);
  const replay = fixture({ replayed: true });
  assert.equal((await replay.service.receive({ ...context(), command: command() })).replayed, true);
  assert.equal(replay.audit.events.length, 0); assert.equal(replay.calls.length, 1);
});

test('scoped source history survives disabled capability and never makes an imported catalogue published', async () => {
  const data = row(); data.currentRevision = 1; data.connectionAvailable = false;
  data.revisions = [{ revision: 1, configurationRevision: 1, recordedAt: time, reference: 'Synthetic source', summary: summary() }];
  const f = fixture({ loaded: data }); const value = await f.service.load(context());
  assert.equal(value.canReceive, false); assert.equal(value.currentRevision, 1);
  assert.equal(value.revisions[0].summary.itemCount, 1);
  assert.equal(Object.isFrozen(value.revisions[0].summary.terms), true);
  assert.doesNotMatch(JSON.stringify(value), /providerPrice|Synthetic coffee/);
  assert.deepEqual(f.calls[0].input, { tenantId: id(1), integrationId: id(3), beforeRevision: null });
  assert.doesNotMatch(JSON.stringify(value), /actorUserId|tenantId|credential|published/);
});

test('Employee, Tenant Admin, Platform, forged permissions, foreign Tenant and missing sessions cannot admit a source', async () => {
  const f = fixture();
  for (const role of ['employee','tenant_admin','platform_admin']) {
    const value = context(); value.principal.roles = [role];
    await assert.rejects(f.service.receive({ ...value, command: command() }));
    await assert.rejects(f.service.load(value));
  }
  const foreign = context(); foreign.tenantContext.tenantId = id(99); await assert.rejects(f.service.load(foreign));
  const missing = context(); delete missing.principal.session;
  await assert.rejects(f.service.receive({ ...missing, command: command() }), /SESSION_REQUIRED/);
  const noPermission = context(); noPermission.principal.permissions = []; await assert.rejects(f.service.load(noPermission));
  assert.equal(f.calls.length, 0);
  for (const extra of [{ attestReceivedFromSupplier: false }, { source: { ...source(), published: true } }, { tenantId: id(99) }]) {
    const error = await f.service.receive({ ...context(), command: { ...command(), ...extra } }).catch((value) => value);
    assert.equal(asApiError(error).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('live authority/source/CAS/replay conflicts are closed failures without retries or partial acknowledgement', async () => {
  for (const status of ['not_authorized','not_found','conflict','configuration_conflict','command_conflict','source_unavailable']) {
    const f = fixture({ status }); const error = await f.service.receive({ ...context(), command: command() }).catch((value) => value);
    assert.equal(asApiError(error).statusCode, status === 'not_authorized' ? 403 : status === 'not_found' ? 404 : 409);
    assert.equal(f.calls.length, 1);
    assert.equal(f.audit.events.filter((event) => event.action === 'catering.catalogue.received').length, 0);
  }
});

test('corrupt receipt/history scopes, private fields, costs and impossible pagination never become safe public output', async () => {
  for (const extra of [{ tenantId: id(99) }, { integrationId: id(99) }, { actorUserId: id(99) }, { actorSecurityVersion: 2 },
    { revision: 2 }, { commandId: id(99) }, { reference: 'Different reference' }, { configurationRevision: 2 },
    { recordedAt: '2026-02-30T12:00:00.000Z' }, { credentialReference: 'private' },
    { source: { ...source(), sourceVersion: 'different' } }]) {
    const f = fixture({ changeReceipt: (value) => ({ ...value, ...extra }) });
    await assert.rejects(f.service.receive({ ...context(), command: command() }));
  }
  for (const extra of [{ tenantId: id(99) }, { integrationId: id(99) }, { credentialReference: 'private' },
    { configurationRevision: 0 }, { nextBeforeRevision: 1 }, { revisions: [{}] }]) {
    await assert.rejects(fixture({ loaded: { ...row(), ...extra } }).service.load(context()));
  }
});

test('source history enforces contiguous immutable revisions, exact bounded cursors and genuine EOF', async () => {
  const data = row(); data.currentRevision = 25;
  const entry = (revision) => ({ revision, configurationRevision: 1, recordedAt: time, reference: 'Synthetic source', summary: summary() });
  data.revisions = Array.from({ length: 20 }, (_, index) => entry(25 - index)); data.nextBeforeRevision = 6;
  const f = fixture({ loaded: data }); assert.equal((await f.service.load(context())).revisions.length, 20);
  data.revisions = Array.from({ length: 5 }, (_, index) => entry(5 - index)); data.nextBeforeRevision = null;
  assert.equal((await f.service.load({ ...context(), beforeRevision: 6 })).revisions.at(-1).revision, 1);
  assert.equal(f.calls.at(-1).input.beforeRevision, 6);
  data.revisions = []; assert.equal((await f.service.load({ ...context(), beforeRevision: 1 })).revisions.length, 0);
  await assert.rejects(f.service.load(context()), /INVALID/);
  data.revisions = [entry(5),entry(3),entry(2),entry(1)];
  await assert.rejects(f.service.load({ ...context(), beforeRevision: 6 }), /INVALID/);
});

test('immutable source detail pages include supplier prices for review with UTF-8 byte bounds and scoped cursors', async () => {
  const detail = stored();
  detail.source.items = Array.from({ length: 6 }, (_, index) => ({
    ...source().items[0], id: `item-${index}`, description: 'ä'.repeat(1000) }));
  const f = fixture({ detail, maxResponseBytes: 4096 });
  let afterEntryId = null; const ids = [];
  do {
    const value = await f.service.loadRevision({ ...context(), revision: 1, section: 'items', afterEntryId });
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096);
    assert.ok(value.entries.length > 0 && value.entries.length < 5);
    assert.equal(value.entries[0].providerPrice.amountMinor, 250);
    assert.equal(Object.isFrozen(value.entries[0]), true);
    assert.doesNotMatch(JSON.stringify(value), /tenantId|actorUserId|commandId|credential/);
    ids.push(...value.entries.map((entry) => entry.id)); afterEntryId = value.nextAfterEntryId;
  } while (afterEntryId !== null);
  assert.deepEqual(ids, Array.from({ length: 6 }, (_, index) => `item-${index}`));
  assert.ok(f.calls.every((call) => call.input.tenantId === id(1) && call.input.integrationId === id(3) && call.input.revision === 1));
  const empty = await f.service.loadRevision({ ...context(), revision: 1, section: 'packages' });
  assert.deepEqual(empty.entries, []); assert.equal(empty.nextAfterEntryId, null);
  await assert.rejects(fixture({ detail, maxResponseBytes: 1024 }).service.loadRevision({ ...context(), revision: 1 }), /TOO_LARGE/);
});
test('detail rejects altered scope/revision, unsafe selection and forged roles before disclosure', async () => {
  for (const extra of [{ tenantId: id(99) }, { integrationId: id(99) }, { revision: 2 }, { credentialReference: 'private' }]) {
    await assert.rejects(fixture({ detail: { ...stored(), ...extra } }).service.loadRevision({ ...context(), revision: 1 }));
  }
  const f = fixture();
  for (const extra of [{ revision: 0 }, { section: 'private' }, { afterEntryId: '../private' }]) {
    const error = await f.service.loadRevision({ ...context(), revision: 1, ...extra }).catch((value) => value);
    assert.equal(asApiError(error).statusCode, 400);
  }
  const admin = context(); admin.principal.roles = ['tenant_admin'];
  await assert.rejects(f.service.loadRevision({ ...admin, revision: 1 })); assert.equal(f.calls.length, 0);
  const missing = await fixture({ detail: null }).service.loadRevision({ ...context(), revision: 1 }).catch((value) => value);
  assert.equal(asApiError(missing).statusCode, 404);
});


test('source discovery retains disabled history and validates all21 scoped rows before a minimized20-entry page', async () => {
  const connection = (integrationId) => {
    const { revisions: _history,nextBeforeRevision: _next,...value } = row(); return { ...value,integrationId };
  };
  const connections = Array.from({ length: 21 },(_,i) => connection(id(100+i)));
  connections[0] = { ...connections[0],configuration: { initialOrderMode: 'manager_review',capabilities: {} },currentRevision: 1,
    connectionAvailable: false };
  const f = fixture({ connections }); const page = await f.service.listConnections(context());
  assert.equal(page.connections.length,20); assert.equal(page.nextAfterIntegrationId,id(119));
  assert.equal(page.connections[0].canReceive,false); assert.equal(page.connections[0].currentRevision,1);
  assert.doesNotMatch(JSON.stringify(page),/tenantId|actorUserId|configuration"|credential|session/);
  for (const change of [ { tenantId: id(9) },{ integrationId: id(100) },{ providerId: 'foreign' },{ private: true } ]) {
    await assert.rejects(fixture({ connections: [...connections.slice(0,20),{ ...connections[20],...change }] })
      .service.listConnections(context()));
  }
  await assert.rejects(fixture({ connections: [{ ...connections[0],currentRevision: 0 }] }).service.listConnections(context()));
  await assert.rejects(f.service.listConnections({ ...context(),afterIntegrationId: id(100) }));
  await assert.rejects(f.service.listConnections({ ...context(),afterIntegrationId: '../foreign' }));
});

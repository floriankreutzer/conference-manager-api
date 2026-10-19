import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringCatalogueAssignmentService } from '../src/application/catering-catalogue-assignment-service.js';
import { CateringCatalogueAssignmentConflictError } from '../src/application/catering-catalogue-assignment-errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const principal = () => ({ tenantId, userId: id(2), roles: ['conference_manager'], permissions: ['tenant:catalogue:manage'],
  session: { id: id(3), securityVersion: 1 } });
const context = () => ({ principal: principal(), tenantContext: { tenantId, status: 'active' }, correlationId: id(4) });
const proposal = () => ({ schemaVersion: 1, expectedRevision: 0, catalogueRevision: 3,
  assignments: [{ kind: 'item', entryId: 'coffee', integrationId: id(5) }] });
const command = () => ({ ...context(), ...proposal() });
function fixture() {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const calls = [];
  let state = { tenantId, revision: 0, currentCatalogueRevision: 3, assignedCatalogueRevision: null, assignments: [], stale: true };
  const inputs = { tenantId, catalogueRevision: 3,
    catalogue: { services: [], equipment: [], cateringPackages: [], cateringItems: [{ id: 'coffee', name: 'Coffee',
      description: null, price: { amountMinor: 100, currency: 'EUR' }, active: true, order: 0, siteIds: [], roomIds: [] }] },
    connections: [{ tenantId, integrationId: id(5) }] };
  const repository = {
    async loadCurrent(input) { calls.push({ operation: 'read', ...input }); return state; },
    async loadProposalInputs(input) { calls.push({ operation: 'inputs', ...input }); return inputs; },
    async listConnections(input) { calls.push({ operation: 'connections', ...input });
      return { items: [{ integrationId: id(5), providerId: 'manual_catering' }], nextAfterIntegrationId: null }; },
    async replace(input) {
      calls.push({ operation: 'write', ...input });
      if (input.expectedRevision !== state.revision) return { status: 'conflict', currentRevision: state.revision };
      const revision = state.revision + 1;
      const event = input.auditEventFor({ revision, catalogueRevision: 3 });
      assert.equal(event.actorUserId, id(2));
      assert.equal(event.tenantId, tenantId);
      assert.deepEqual(event.newState, { revision, catalogueRevision: 3 });
      assert.deepEqual(event.metadata, { operation: 'catering_catalogue_assignment_replace' });
      state = { tenantId, revision, currentCatalogueRevision: 3, assignedCatalogueRevision: 3,
        assignments: input.proposal.assignments, stale: false };
      return { status: 'updated', current: state };
    },
  };
  const make = (options = {}) => createCateringCatalogueAssignmentService({ repository, authorizationPolicy, auditService: audit.service,
    clock: () => Date.parse('2026-10-19T09:00:00.000Z'), ...options });
  return { service: make(), make, inputs, repository, calls, audit };
}

test('Manager writes scoped ownership with separate revisions, session fence and minimized audit', async () => {
  const f = fixture();
  const empty = await f.service.current(context());
  assert.equal(empty.revision, 0);
  assert.equal(empty.stale, true);
  const saved = await f.service.replace(command());
  assert.equal(saved.revision, 1);
  assert.equal(saved.assignedCatalogueRevision, 3);
  assert.equal(saved.stale, false);
  const write = f.calls.find((call) => call.operation === 'write');
  assert.equal(write.sessionId, id(3));
  assert.equal(write.expectedSecurityVersion, 1);
  assert.equal(write.tenantId, tenantId);
  assert.equal(write.actorUserId, id(2));
  assert.deepEqual(write.proposal, { schemaVersion: 1, catalogueRevision: 3, assignments: proposal().assignments });
  assert.deepEqual(await f.service.current(context()), saved);
  const page = await f.service.listConnections(context());
  assert.deepEqual(page.connections, [{ integrationId: id(5), providerId: 'manual_catering' }]);
  assert.equal(JSON.stringify(page).includes('capabilities'), false);
});

test('Employee, Tenant Admin alone, spoofed Manager permissions and cross-Tenant callers cannot reach catalogue ports', async () => {
  for (const actor of [
    { ...principal(), roles: ['employee'], permissions: ['request:read'] },
    { ...principal(), roles: ['tenant_admin'], permissions: ['tenant:integrations:manage'] },
    { ...principal(), roles: ['tenant_admin'] }, { ...principal(), permissions: [] },
    { ...principal(), tenantId: id(9) },
  ]) {
    const f = fixture();
    const ctx = { ...context(), principal: actor };
    await assert.rejects(f.service.current(ctx));
    await assert.rejects(f.service.listConnections(ctx));
    await assert.rejects(f.service.replace({ ...command(), principal: actor }));
    assert.deepEqual(f.calls, []);
  }
  for (const status of ['pending', 'onboarding', 'ready', 'suspended', 'archived']) {
    const f = fixture();
    await assert.rejects(f.service.replace({ ...command(), tenantContext: { tenantId, status } }));
    assert.deepEqual(f.calls, []);
  }
});

test('writes reject missing session, stale canonical revision, unknown/foreign connection and malformed positive input', async () => {
  for (const change of [{ principal: { ...principal(), session: undefined } }, { schemaVersion: 2 }, { expectedRevision: -1 },
    { catalogueRevision: 2 }, { catalogueRevision: 4 }, { assignments: [{ ...proposal().assignments[0], providerId: 'untrusted' }] },
    { assignments: [{ ...proposal().assignments[0], integrationId: id(9) }] }]) {
    const f = fixture();
    await assert.rejects(f.service.replace({ ...command(), ...change }));
    assert.equal(f.calls.some((call) => call.operation === 'write'), false);
  }
  const f = fixture();
  f.inputs.connections[0].tenantId = id(9);
  await assert.rejects(f.service.replace(command()));
  assert.equal(f.calls.some((call) => call.operation === 'write'), false);
});

test('transaction-time revocation, zero-revision CAS and catalogue races never acknowledge success', async () => {
  for (const outcome of [{ status: 'not_authorized' }, { status: 'conflict', currentRevision: 0 },
    { status: 'catalogue_conflict', currentRevision: 4 }]) {
    const f = fixture();
    const service = f.make({ repository: { ...f.repository, replace: async () => outcome } });
    await assert.rejects(service.replace(command()));
  }
  const mapped = asApiError(new CateringCatalogueAssignmentConflictError(0));
  assert.equal(mapped.statusCode, 409);
  assert.equal(mapped.code, 'CATERING_ASSIGNMENT_REVISION_CONFLICT');
  assert.deepEqual(mapped.context, { currentRevision: 0 });
  assert.throws(() => new CateringCatalogueAssignmentConflictError(-1));
});

test('corrupt repository scopes, private projection fields, changed assignments or acknowledgement revisions fail closed', async () => {
  for (const change of [{ tenantId: id(9) }, { revision: 2 }, { privateReference: 'untrusted' },
    { assignments: [{ ...proposal().assignments[0], integrationId: id(9) }] }, { currentCatalogueRevision: 4 }]) {
    const f = fixture();
    const bad = { tenantId, revision: 1, currentCatalogueRevision: 3, assignedCatalogueRevision: 3,
      assignments: proposal().assignments, stale: false, ...change };
    const service = f.make({ repository: { ...f.repository, replace: async () => ({ status: 'updated', current: bad }) } });
    await assert.rejects(service.replace(command()));
  }
  const f = fixture();
  f.inputs.tenantId = id(9);
  await assert.rejects(f.service.replace(command()), /REPOSITORY_SCOPE_INVALID/);
});

test('safe terminal revisions remain readable and cannot overflow into another assignment mutation', async () => {
  const f = fixture();
  const service = f.make({ repository: { ...f.repository, loadCurrent: async () => ({ tenantId,
    revision: Number.MAX_SAFE_INTEGER - 1, currentCatalogueRevision: 3, assignedCatalogueRevision: 3,
    assignments: proposal().assignments, stale: false }) } });
  assert.equal((await service.current(context())).revision, Number.MAX_SAFE_INTEGER - 1);
  await assert.rejects(service.replace({ ...command(), expectedRevision: Number.MAX_SAFE_INTEGER - 1 }));
  assert.equal(f.calls.some((call) => call.operation === 'write'), false);
});

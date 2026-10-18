import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { createRequestDraftWorkflowService } from '../src/application/request-draft-workflow-service.js';
import { createAuthorizationPolicy, PERMISSION, TENANT_ROLE } from '../src/authorization/policy.js';
import { createApplicationHttpHandler, applicationRouteKey } from '../src/http/application-routes.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const WORKFLOW = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const CORRELATION = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-10-18T09:00:00.000Z';
const PATH = '/api/v1/application/request-workflows';
const principal = Object.freeze({ userId: USER, tenantId: TENANT,
  roles: [TENANT_ROLE.EMPLOYEE], permissions: [PERMISSION.REQUEST_READ],
  session: { securityVersion: 7 } });
const common = { principal, tenantContext: { tenantId: TENANT, status: 'active' }, correlationId: CORRELATION };
const workflow = { id: WORKFLOW, status: 'started', startedAt: NOW, endedAt: null };

function serviceHarness(result = { status: 'started', workflow }) {
  const calls = [];
  const repository = {
    async startForOwner(args) { calls.push(args); return result; },
    async abandonForOwner(args) { calls.push(args); return result; },
  };
  const service = createRequestDraftWorkflowService({ repository,
    authorizationPolicy: createAuthorizationPolicy(), auditService: { createEvent: (value) => value },
    clock: () => Date.parse(NOW), idFactory: () => WORKFLOW });
  return { service, calls };
}

test('Request start and explicit abandon use server identity, clock and the same target without content', async () => {
  const { service, calls } = serviceHarness();
  assert.deepEqual(await service.startRequestWorkflow({ ...common, idempotencyKey: KEY }), workflow);
  await service.abandonRequestWorkflow({ ...common, workflowId: WORKFLOW });
  assert.deepEqual(calls.map((entry) => entry.auditEvent.action), ['request.started', 'request.abandoned']);
  for (const call of calls) {
    assert.equal(call.tenantId, TENANT);
    assert.equal(call.ownerUserId, USER);
    assert.equal(call.securityVersion, 7);
    assert.equal(call.workflowId, WORKFLOW);
    assert.equal(call.changedAt.toISOString(), NOW);
    assert.equal(call.auditEvent.occurredAt, NOW);
    assert.equal(call.auditEvent.targetId, WORKFLOW);
    assert.equal(call.auditEvent.targetType, 'request');
    assert.equal(call.auditEvent.retentionClass, 'business');
    assert.deepEqual(Object.keys(call.auditEvent.metadata), ['operation']);
  }
});

test('Request lifecycle rejects foreign tenant, unknown role, missing session epoch and malformed refs before persistence', async () => {
  for (const input of [
    { tenantContext: { tenantId: KEY, status: 'active' } },
    { principal: { ...principal, roles: ['owner'] } },
    { principal: { ...principal, permissions: [] } },
    { principal: { ...principal, session: null } },
    { idempotencyKey: '../foreign' },
    { idempotencyKey: [KEY] },
  ]) {
    const { service, calls } = serviceHarness();
    await assert.rejects(service.startRequestWorkflow({ ...common, idempotencyKey: KEY, ...input }));
    assert.equal(calls.length, 0);
  }
  const { service, calls } = serviceHarness();
  await assert.rejects(service.abandonRequestWorkflow({ ...common, workflowId: 'not-an-id' }));
  assert.equal(calls.length, 0);
});

test('Lifecycle ownership misses are concealed and terminal conflicts remain conflicts', async () => {
  const missing = serviceHarness({ status: 'not_found' }).service;
  await assert.rejects(missing.abandonRequestWorkflow({ ...common, workflowId: WORKFLOW }),
    (error) => error.code === 'RESOURCE_NOT_AVAILABLE' && error.conceal === true);
  const conflict = serviceHarness({ status: 'conflict' }).service;
  await assert.rejects(conflict.abandonRequestWorkflow({ ...common, workflowId: WORKFLOW }),
    (error) => error.code === 'REQUEST_STATE_CONFLICT');
});

function httpHarness({ rejectAuthority = null } = {}) {
  const calls = [];
  const handler = createApplicationHttpHandler({
    service: {
      async startRequestWorkflow(args) { calls.push(['start', args]); return workflow; },
      async abandonRequestWorkflow(args) { calls.push(['abandon', args]); return workflow; },
    },
    principalGuard: { async require(_request, options) {
      calls.push(['principal', options]);
      if (rejectAuthority) throw rejectAuthority;
      return principal;
    } },
    tenantGuard: { async requireKnown() { throw new Error('WRONG_TENANT_GUARD'); },
      async requireActive(value) { assert.equal(value, principal); return common.tenantContext; } },
    maxBodyBytes: 16_384, maxResponseBytes: 16_384,
  });
  async function invoke({ path = PATH, method = 'POST', body = {}, headers = {} } = {}) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.headers = { 'content-type': 'application/json', 'idempotency-key': KEY, ...headers };
    const response = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    const code = await handler({ request, response, path: new URL(path, 'http://localhost').pathname,
      parsedUrl: new URL(path, 'http://localhost'), requestId: CORRELATION });
    return { code, body: response.body };
  }
  return { calls, invoke };
}

test('Lifecycle HTTP routes require active principal/tenant and CSRF and expose bounded route keys', async () => {
  const { invoke, calls } = httpHarness();
  assert.equal((await invoke()).code, 200);
  await invoke({ path: `${PATH}/${WORKFLOW}/abandon` });
  assert.deepEqual(calls.filter(([kind]) => kind === 'principal').map(([, value]) => value),
    [{ csrf: true }, { csrf: true }]);
  assert.equal(calls.find(([kind]) => kind === 'start')[1].idempotencyKey, KEY);
  assert.equal(calls.find(([kind]) => kind === 'abandon')[1].workflowId, WORKFLOW);
  assert.equal(applicationRouteKey(PATH), 'application_request_workflows');
  assert.equal(applicationRouteKey(`${PATH}/${WORKFLOW}/abandon`), 'application_request_workflow_abandon');
  for (const rejection of [new ApiError(401, 'SESSION_INVALID'), new ApiError(403, 'CSRF_INVALID')]) {
    const denied = httpHarness({ rejectAuthority: rejection });
    await assert.rejects(denied.invoke(), (error) => error === rejection);
    assert.equal(denied.calls.some(([kind]) => ['start', 'abandon'].includes(kind)), false);
  }
});

test('Lifecycle HTTP positive schemas reject client clocks, content, ownership, status, query and ambiguous keys', async () => {
  for (const input of [
    { body: { startedAt: NOW } }, { body: { tenantId: TENANT } }, { body: { userId: USER } },
    { body: { request: { title: 'Private draft' } } }, { body: { status: 'submitted' } },
    { headers: { 'idempotency-key': undefined } }, { headers: { 'idempotency-key': [KEY, KEY] } },
    { path: `${PATH}?tenantId=${TENANT}` }, { method: 'GET' },
    { body: { text: 'x'.repeat(1_025) } },
    { path: `${PATH}/${WORKFLOW}/abandon`, body: { endedAt: NOW } },
  ]) {
    const { calls, invoke } = httpHarness();
    await assert.rejects(invoke(input), (error) => error instanceof ApiError);
    assert.equal(calls.some(([kind]) => ['start', 'abandon'].includes(kind)), false);
  }
});

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { cateringProviderCatalogueRouteKey, createCateringProviderCatalogueHttpHandler } from '../src/http/catering-provider-catalogues.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const ROOT = `/api/v1/tenant/catering/provider-catalogues/${id(3)}`;
const source = () => ({ schemaVersion: 1, sourceVersion: null, items: [], packages: [], terms: {
  minimumLeadTimeMinutes: null, minimumOrderValue: null, changeCutoffMinutes: null, cancelCutoffMinutes: null } });
const command = () => ({ schemaVersion: 1, commandId: id(100), expectedRevision: 0, expectedConfigurationRevision: 1,
  reference: 'Synthetic supplier source', attestReceivedFromSupplier: true, source: source() });
function fixture({ denied = false, output = { schemaVersion: 1 }, ceiling = 1048576, serviceAvailable = true } = {}) {
  const calls = []; const guards = [];
  const service = Object.fromEntries(['listConnections','load','loadRevision','receive'].map((operation) => [operation, async (input) => {
    calls.push({ operation,input }); return output;
  }]));
  const principal = { tenantId: id(1), userId: id(20) };
  const tenantContext = { tenantId: id(1), status: 'active' };
  const handler = createCateringProviderCatalogueHttpHandler({ service: serviceAvailable ? service : null,
    maxBodyBytes: 1024, maxResponseBytes: ceiling, principalGuard: { async require(_request, options) {
      guards.push(options); if (denied) throw new ApiError(403, 'FORBIDDEN'); return principal;
    } }, tenantGuard: { async requireActive(value) { assert.equal(value,principal); return tenantContext; } } });
  async function invoke({ method = 'GET', path = ROOT, body = '', headers = {} } = {}) {
    const bytes = Buffer.from(body); const request = Readable.from(bytes.length ? [bytes] : []);
    request.method = method; request.headers = { 'content-length': String(bytes.length), 'content-type': 'application/json', ...headers };
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
    const parsedUrl = new URL(path, 'http://localhost:3000');
    return { pending: handler({ request,response,path: parsedUrl.pathname,parsedUrl,requestId: id(90) }), response };
  }
  return { calls,guards,invoke,principal,tenantContext };
}

test('source history/detail routes bind trusted scope and exact canonical cursors; writes carry only declared command intent', async () => {
  const f = fixture();
  let answer = await f.invoke({ path: `${ROOT}?beforeRevision=3` }); assert.equal(await answer.pending,200);
  assert.deepEqual(f.calls[0], { operation: 'load', input: { principal: f.principal, tenantContext: f.tenantContext,
    correlationId: id(90), integrationId: id(3), beforeRevision: 3 } });
  answer = await f.invoke({ path: `${ROOT}/revisions/2?section=packages&afterEntryId=break-1` });
  assert.equal(await answer.pending,200); assert.equal(f.calls[1].operation,'loadRevision');
  assert.equal(f.calls[1].input.revision,2); assert.equal(f.calls[1].input.section,'packages');
  assert.equal(f.calls[1].input.afterEntryId,'break-1');
  answer = await f.invoke({ method: 'POST', body: JSON.stringify(command()) }); assert.equal(await answer.pending,200);
  assert.equal(f.calls[2].operation,'receive'); assert.deepEqual(f.calls[2].input.command,command());
  assert.deepEqual(f.guards, [{ csrf: false },{ csrf: false },{ csrf: true }]);
  assert.equal(Number(answer.response.headers['Content-Length']),Buffer.byteLength(answer.response.body));
});
test('queries and bodies cannot replace Tenant/provider scope, introduce ambiguous cursors or mutate immutable source detail', async () => {
  const f = fixture();
  for (const suffix of ['?tenantId=foreign','?beforeRevision=0','?beforeRevision=01','?beforeRevision=1&beforeRevision=2',
    '?beforeRevision=9007199254740991','/revisions/1?section=private','/revisions/1?afterEntryId=../private',
    '/revisions/1?section=items&section=packages','/revisions/1?tenantId=foreign']) {
    const answer = await f.invoke({ path: ROOT + suffix }); await assert.rejects(answer.pending, (error) => error.statusCode === 400);
  }
  let answer = await f.invoke({ body: '{}' }); await assert.rejects(answer.pending, /REQUEST_BODY_NOT_ALLOWED/);
  answer = await f.invoke({ method: 'POST', path: `${ROOT}?beforeRevision=1`, body: JSON.stringify(command()) });
  await assert.rejects(answer.pending, /VALIDATION_FAILED/);
  answer = await f.invoke({ method: 'POST', path: `${ROOT}/revisions/1`, body: JSON.stringify(command()) });
  await assert.rejects(answer.pending, (error) => error.statusCode === 405);
  assert.equal(answer.response.headers.Allow,'GET'); assert.equal(f.guards.at(-1).csrf,true);
  assert.equal(f.calls.length,0);
});
test('positive outer command, encoding and byte schemas reject untrusted authority before delegation', async () => {
  const f = fixture();
  for (const extra of [{ tenantId: id(99) },{ providerId: 'invented' },{ attestReceivedFromSupplier: false },
    { expectedRevision: -1 },{ expectedConfigurationRevision: 0 },{ commandId: 'invalid' },{ schemaVersion: 2 },{ source: [] }]) {
    const answer = await f.invoke({ method: 'POST', body: JSON.stringify({ ...command(), ...extra }) });
    await assert.rejects(answer.pending, (error) => error.statusCode === 400);
  }
  for (const [body,headers,status] of [['[]',{},400],['private',{},400],['',{},400],
    [JSON.stringify(command()),{ 'content-type': 'text/plain' },415],
    [JSON.stringify(command()),{ 'content-encoding': 'gzip' },415],
    ['x'.repeat(1025),{ 'content-length': '0' },413]]) {
    const answer = await f.invoke({ method: 'POST',body,headers });
    await assert.rejects(answer.pending, (error) => error.statusCode === status);
  }
  assert.equal(f.calls.length,0);
});
test('closed method/guard/unavailability and UTF-8 response bounds never produce premature success', async () => {
  let f = fixture({ denied: true }); let answer = await f.invoke({ method: 'POST',body: JSON.stringify(command()) });
  await assert.rejects(answer.pending, /FORBIDDEN/); assert.equal(f.calls.length,0);
  f = fixture({ serviceAvailable: false }); answer = await f.invoke();
  await assert.rejects(answer.pending, /UNAVAILABLE/); assert.equal(f.guards.length,0);
  f = fixture({ output: { value: 'ä'.repeat(700) }, ceiling: 1024 }); answer = await f.invoke();
  await assert.rejects(answer.pending, /RESPONSE_TOO_LARGE/); assert.equal(answer.response.statusCode,undefined);
  f = fixture(); answer = await f.invoke({ method: 'PUT',body: '{}' });
  await assert.rejects(answer.pending, (error) => error.statusCode === 405);
  assert.equal(answer.response.headers.Allow,'GET, POST'); assert.equal(f.guards[0].csrf,true);
  for (const path of [ROOT + '/revisions/0',ROOT + '/revisions/01',ROOT + '/revisions/9007199254740991',ROOT + '/extra']) {
    assert.equal(cateringProviderCatalogueRouteKey(path),null);
    assert.equal(await (await f.invoke({ path })).pending,null);
  }
  assert.equal(cateringProviderCatalogueRouteKey(ROOT),'catering_provider_catalogues');
  assert.equal(cateringProviderCatalogueRouteKey(ROOT + '/revisions/1'),'catering_provider_catalogue_details');
});


test('source connection history discovery is read-only with one canonical cursor and trusted Tenant scope', async () => {
  const f = fixture(); const root = '/api/v1/tenant/catering/provider-catalogues';
  const read = await f.invoke({ path: `${root}?afterIntegrationId=${id(3)}` }); assert.equal(await read.pending,200);
  assert.equal(f.calls[0].operation,'listConnections'); assert.equal(f.calls[0].input.afterIntegrationId,id(3));
  assert.equal(f.calls[0].input.tenantContext.tenantId,id(1));
  assert.equal(cateringProviderCatalogueRouteKey(root),'catering_provider_catalogue_connections');
  for (const suffix of ['?tenantId=foreign','?afterIntegrationId=foreign',`?afterIntegrationId=${id(3)}&afterIntegrationId=${id(3)}`]) {
    await assert.rejects((await f.invoke({ path: root+suffix })).pending,(error) => error.statusCode === 400);
  }
  await assert.rejects((await f.invoke({ path: root,method: 'POST' })).pending,(error) => error.statusCode === 405);
  assert.equal(f.calls.length,1);
});

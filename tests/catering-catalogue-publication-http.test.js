import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { cateringCataloguePublicationRouteKey,
  createCateringCataloguePublicationHttpHandler } from '../src/http/catering-catalogue-publication.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const ROOT = `/api/v1/tenant/catering/provider-catalogues/${id(3)}`;
const command = () => ({ schemaVersion: 1,commandId: id(100),expectedReviewRevision: 0,expectedSourceRevision: 1,
  expectedConfigurationRevision: 1,expectedCatalogueRevision: 2,expectedAssignmentRevision: 1,expectedPublicationRevision: 0,
  decision: 'rejected',justification: 'Synthetic explicit rejection of received content',items: [],packages: [] });
function fixture({ denied = false,output = { schemaVersion: 1 },ceiling = 524288,available = true } = {}) {
  const calls = []; const guards = [];
  const operation = (name) => async (input) => { calls.push({ name,input }); return output; };
  const principal = { tenantId: id(1),userId: id(20) }; const tenantContext = { tenantId: id(1),status: 'active' };
  const handler = createCateringCataloguePublicationHttpHandler({
    writeService: available ? { review: operation('review') } : null,
    readService: available ? { loadContext: operation('context'),listHistory: operation('history') } : null,
    maxBodyBytes: 1024,maxResponseBytes: ceiling,principalGuard: { async require(_request,options) {
      guards.push(options); if (denied) throw new ApiError(403,'FORBIDDEN'); return principal;
    } },tenantGuard: { async requireActive(value) { assert.equal(value,principal); return tenantContext; } } });
  function invoke({ method = 'GET',path = `${ROOT}/review`,body = '',headers = {} } = {}) {
    const bytes = Buffer.from(body); const request = Readable.from(bytes.length ? [bytes] : []);
    request.method=method; request.headers={ 'content-length': String(bytes.length),'content-type': 'application/json',...headers };
    const response = { headers: {},setHeader(key,value) { this.headers[key]=value; },end(value) { this.body=value; } };
    const parsedUrl = new URL(path,'http://localhost:3000');
    return { pending: handler({ request,response,path: parsedUrl.pathname,parsedUrl,requestId: id(90) }),response };
  }
  return { calls,guards,principal,tenantContext,invoke };
}

test('publication routes keep observed versions and closed cursor intent subordinate to actual principal and Tenant guards',async () => {
  const f = fixture();
  let answer = f.invoke({ path: `${ROOT}/review?afterKind=package&afterEntryId=break&publicationRevision=3` });
  assert.equal(await answer.pending,200);
  assert.deepEqual(f.calls[0],{ name: 'context',input: { principal: f.principal,tenantContext: f.tenantContext,
    correlationId: id(90),integrationId: id(3),afterBinding: { kind: 'package',entryId: 'break' },publicationRevision: 3 } });
  answer=f.invoke({ path: `${ROOT}/reviews?beforeRevision=3` }); assert.equal(await answer.pending,200);
  assert.equal(f.calls[1].name,'history'); assert.equal(f.calls[1].input.beforeRevision,3);
  answer=f.invoke({ method: 'POST',body: JSON.stringify(command()) }); assert.equal(await answer.pending,200);
  assert.deepEqual(f.calls[2].input.command,command()); assert.equal(f.calls[2].name,'review');
  assert.deepEqual(f.guards,[{ csrf: false },{ csrf: false },{ csrf: true }]);
  assert.equal(Number(answer.response.headers['Content-Length']),Buffer.byteLength(answer.response.body));
});
test('ambiguous cursors, Tenant/provider overrides, GET bodies and unsupported history writes cannot reach services',async () => {
  const f = fixture();
  for (const path of [`${ROOT}/review?tenantId=foreign`,`${ROOT}/review?afterKind=item`,
    `${ROOT}/review?afterKind=item&afterEntryId=a`,`${ROOT}/review?afterKind=foreign&afterEntryId=a&publicationRevision=1`,
    `${ROOT}/review?publicationRevision=01`,`${ROOT}/review?publicationRevision=1&publicationRevision=2`,
    `${ROOT}/review?afterKind=item&afterEntryId=../a&publicationRevision=1`,`${ROOT}/reviews?beforeRevision=0`,
    `${ROOT}/reviews?beforeRevision=1&beforeRevision=2`,`${ROOT}/reviews?publicationRevision=0`]) {
    await assert.rejects(f.invoke({ path }).pending,(error) => error.statusCode === 400);
  }
  await assert.rejects(f.invoke({ body: '{}' }).pending,/REQUEST_BODY_NOT_ALLOWED/);
  await assert.rejects(f.invoke({ method: 'POST',path: `${ROOT}/review?providerId=foreign`,body: JSON.stringify(command()) }).pending,
    (error) => error.statusCode === 400);
  const history = f.invoke({ method: 'POST',path: `${ROOT}/reviews`,body: JSON.stringify(command()) });
  await assert.rejects(history.pending,(error) => error.statusCode === 405); assert.equal(history.response.headers.Allow,'GET');
  assert.equal(f.guards.at(-1).csrf,true); assert.equal(f.calls.length,0);
});
test('closed command and transport bounds reject hidden authority, malformed encoding and excessive bytes',async () => {
  const f = fixture();
  for (const extra of [{ tenantId: id(99) },{ actorUserId: id(99) },{ providerId: 'foreign' },{ decision: 'approved' },
    { expectedReviewRevision: -1 },{ expectedSourceRevision: 0 },{ expectedCatalogueRevision: Number.MAX_SAFE_INTEGER },
    { justification: '' },{ items: {} },{ commandId: 'invalid' },{ schemaVersion: 2 }]) {
    await assert.rejects(f.invoke({ method: 'POST',body: JSON.stringify({ ...command(),...extra }) }).pending,
      (error) => error.statusCode === 400);
  }
  for (const [body,headers,status] of [['[]',{},400],['',{},400],['private',{},400],
    [JSON.stringify(command()),{ 'content-type': 'text/plain' },415],
    [JSON.stringify(command()),{ 'content-encoding': 'gzip' },415],['x'.repeat(1025),{ 'content-length': '0' },413]]) {
    await assert.rejects(f.invoke({ method: 'POST',body,headers }).pending,(error) => error.statusCode === status);
  }
  assert.equal(f.calls.length,0);
});
test('unsafe methods require CSRF before405, denied authority cannot disclose output and fixed response byte limits remain',async () => {
  const f = fixture(); const answer = f.invoke({ method: 'DELETE' });
  await assert.rejects(answer.pending,(error) => error.statusCode === 405); assert.equal(answer.response.headers.Allow,'GET, POST');
  assert.deepEqual(f.guards,[{ csrf: true }]); assert.equal(f.calls.length,0);
  const denied = fixture({ denied: true });
  await assert.rejects(denied.invoke({ method: 'POST',body: JSON.stringify(command()) }).pending,/FORBIDDEN/);
  assert.equal(denied.calls.length,0);
  await assert.rejects(fixture({ available: false }).invoke().pending,(error) => error.statusCode === 503);
  await assert.rejects(fixture({ output: { text: 'ä'.repeat(600) },ceiling: 1024 }).invoke().pending,/RESPONSE_TOO_LARGE/);
});
test('only two exact scoped routes contribute fixed telemetry identifiers',async () => {
  assert.equal(cateringCataloguePublicationRouteKey(`${ROOT}/review`),'catering_catalogue_review');
  assert.equal(cateringCataloguePublicationRouteKey(`${ROOT}/reviews`),'catering_catalogue_reviews');
  for (const path of [ROOT,`${ROOT}/reviews/1`,`${ROOT}/review/`,`${ROOT}/reviewer`,ROOT.replace(id(3),'foreign')+'/review']) {
    const f = fixture(); assert.equal(cateringCataloguePublicationRouteKey(path),null);
    assert.equal(await f.invoke({ path }).pending,null); assert.equal(f.calls.length,0); assert.equal(f.guards.length,0);
  }
});

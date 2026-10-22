import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { platformAuditRoutes } from '../src/platform/http/audit-routes.js';

const id='11111111-1111-4111-8111-111111111111';
const audit={ segmentId: id,verification: 'verified',legacy: { eventCount: 124,verification: 'unavailable' } };
function fixture(verification=audit) {
  const calls=[];let body=null;
  const handler=platformAuditRoutes.createHandler({ maxResponseBytes: 8192,
    platformPrincipalGuard: { async require() { return { operatorId: id }; } },platformAuditService: {
      async list(input) { calls.push(['list',input]);return []; },
      async export(input) { calls.push(['export',input]);return []; },
      async verificationContext(input) { calls.push(['context',input]);return verification; },
    } });
  return { calls,body: ()=>body,async invoke(path='/api/v1/platform/audit/events?beforeSequence=125') {
    const request=Readable.from([]);request.method='GET';request.headers={};
    const parsedUrl=new URL(path,'https://ops-int.example.test');
    return handler({ path: parsedUrl.pathname,parsedUrl,request,requestId: id,
      response: { setHeader() {},end(value) { body=JSON.parse(value); } } });
  } };
}

test('audit HTTP v2 preserves the unavailable legacy context and permits global cursors beginning with one',async()=>{
  const f=fixture();await f.invoke();assert.deepEqual(f.body(),{ schemaVersion: 2,audit,items: [] });
  assert.equal(f.calls[0][1].beforeSequence,125);assert.equal(f.calls[1][1].exporting,false);
  await f.invoke('/api/v1/platform/audit/exports?limit=100');assert.equal(f.calls.at(-1)[1].exporting,true);
});

test('audit HTTP keeps v1 compatibility and refuses segment selection, malformed cursors and fabricated verification',async()=>{
  const legacy=fixture(null);await legacy.invoke();assert.deepEqual(legacy.body(),{ schemaVersion: 1,items: [] });
  for (const query of ['beforeSequence=1','beforeSequence=01','beforeSequence=9007199254740992','segmentId='+id,
    'limit=100&limit=1','legacyVerified=true']) {
    const f=fixture();await assert.rejects(f.invoke('/api/v1/platform/audit/events?'+query));assert.equal(f.calls.length,0);
  }
  const forged=fixture({ ...audit,legacy: { eventCount: 124,verification: 'verified' } });
  await assert.rejects(forged.invoke());assert.equal(forged.body(),null);
});

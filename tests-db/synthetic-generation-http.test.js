import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPlatformOperatorRepository } from '../src/persistence/postgres/platform-operator-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresSyntheticGenerationDirectoryRepository }
  from '../src/persistence/postgres/platform-synthetic-generation-directory-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createSyntheticGenerationProtocol } from '../src/platform/application/synthetic-generation-protocol.js';
import { createPlatformSyntheticGenerationRouteModule } from '../src/platform/http/synthetic-generation-routes.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { createPlatformLogger } from '../src/platform/http/observability.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

const pair=value=>value.split(';')[0];
// Explicit internal Microsoft-shaped primary fixtures; actual software P256,
// PostgreSQL, HTTP, proof/continuation/commit and Tenant/Platform audits run here.
test('native max1 own generation HTTP uses fresh signed create/reset, retains private history and rolls every grant back on commit failure',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 }),servers=[],logs=[];
  t.after(async()=>{ await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
    await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const foreign=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const failed=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const policy=createPlatformAuthorizationPolicy(),tenantAudit=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const config={ mode: 'test',serviceVersion: '0.1.0',buildId: 'native-generation-http',publicOrigin: scope.platformOrigin,
    entraAuthority: `https://login.microsoftonline.com/${randomUUID()}`,entraClientId: randomUUID(),
    entraRedirectUri: `${scope.platformOrigin}/api/v1/platform/auth/microsoft/callback`,mfaAuthenticationContext: 'c1',
    stepUpAuthenticationContext: 'c2',authenticationMaxAgeSeconds: 900,maxBodyBytes: 32768,maxResponseBytes: 65536,
    rateLimitMax: 120,rateLimitWindowMs: 60000,rateLimitMaxKeys: 100,requestTimeoutMs: 5000,headersTimeoutMs: 5000,
    keepAliveTimeoutMs: 1000 };
  async function surface(actor) {
    const generations=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,passkeyService: actor.auth,
      authorizationPolicy: policy,repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
        tenantAuditRepository: tenantAudit,platformAuditRepository: actor.auditRepository }) });
    const protocol=createSyntheticGenerationProtocol({ generationService: generations,passkeyService: actor.auth,
      directory: createPostgresSyntheticGenerationDirectoryRepository(pool,scope),withPreparationScope: actor.scopes.withShared });
    const audit=createPlatformAuditService({ repository: actor.auditRepository,authorizationPolicy: policy,
      tenantTargetPolicy: createPlatformTenantTargetPolicy({
        operatorRepository: createPostgresPlatformOperatorRepository(pool,{ auditRepository: actor.auditRepository }) }) });
    const server=createPlatformHttpServer({ config,platformSessionService: actor.sessions,platformAuditService: audit,
      logger: createPlatformLogger({ write: line=>logs.push(line) }),
      routeModules: [createPlatformSyntheticGenerationRouteModule({ protocol,scope })] });
    servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let cookie=pair(actor.current().setCookie),csrf=actor.current().csrfToken,counter=0;
    async function request(path='',{ method='GET',body,headers={} }={}) {
      const raw=body===undefined ? null : JSON.stringify(body);
      return new Promise((resolve,reject)=>{
        const outgoing=http.request({ hostname: '127.0.0.1',port: server.address().port,path: '/api/v1/platform/synthetic/generation'+path,
          method,headers: { host: new URL(scope.platformOrigin).host,cookie,
            ...(method==='POST' ? { origin: scope.platformOrigin,'sec-fetch-site': 'same-origin','x-csrf-token': csrf } : {}),
            ...(raw===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(raw) }),...headers } },
        incoming=>{
          const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>resolve({ status: incoming.statusCode,
            headers: incoming.headers,text: Buffer.concat(chunks).toString('utf8') }));
        });outgoing.on('error',reject);outgoing.end(raw);
      });
    }
    async function replace(intent) {
      const prepared=await request('/options',{ method: 'POST',body: intent });assert.equal(prepared.status,200);
      const challenge=JSON.parse(prepared.text);counter++;
      const answer=await request('/replace',{ method: 'POST',body: { ...intent,state: challenge.state,
        response: actor.keys[0].response('get',{ counter,client: { challenge: challenge.options.challenge } }) },
      headers: { cookie: `${cookie}; ${pair(prepared.headers['set-cookie'][0])}` } });
      if (answer.status===200) { cookie=pair(answer.headers['set-cookie'][0]);csrf=JSON.parse(answer.text).csrfToken; }
      return answer;
    }
    return { request,replace };
  }
  const own=await surface(owner),other=await surface(foreign),failure=await surface(failed);
  const empty=await own.request();assert.equal(empty.status,200);assert.equal(JSON.parse(empty.text).generation,null);
  const created=await own.replace({ expectedGenerationId: null,expectedRevision: 0 });assert.equal(created.status,200);
  const first=JSON.parse(created.text).generation;assert.equal(first.revision,2);
  assert.deepEqual(first.tenants.map(tenant=>tenant.status),['active','ready','onboarding']);
  const current=await own.request();assert.equal(current.status,200);assert.equal(JSON.parse(current.text).canReplace,false);
  assert.equal(JSON.parse(current.text).generation.generationId,first.generationId);
  assert.equal(JSON.parse((await other.request()).text).generation,null);
  assert.equal((await other.request('/options',{ method: 'POST',body: { expectedGenerationId: first.generationId,
    expectedRevision: first.revision } })).status,409);
  assert.equal((await own.request('/options',{ method: 'POST',body: { expectedGenerationId: first.generationId,
    expectedRevision: first.revision } })).status,409);
  assert.equal((await own.request('/options',{ method: 'POST',body: { expectedGenerationId: null,expectedRevision: 0,
    operatorId: foreign.operatorId } })).status,400);
  // Actual existing10s cooldown, no clock/row/expiry edits or deadline increase.
  await new Promise(resolve=>setTimeout(resolve,10_100));
  const reset=await own.replace({ expectedGenerationId: first.generationId,expectedRevision: first.revision });
  assert.equal(reset.status,200);
  const next=JSON.parse(reset.text).generation;assert.notEqual(next.generationId,first.generationId);
  const history=(await pool.query(`SELECT tenant.status,
    (SELECT count(*)::int FROM requests WHERE tenant_id=tenant.id) AS requests,
    (SELECT count(*)::int FROM rooms WHERE tenant_id=tenant.id) AS rooms FROM tenants tenant WHERE id=$1`,
  [first.tenants[0].tenantId])).rows[0];assert.deepEqual(history,{ status: 'archived',requests: 20,rooms: 10 });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_tenant_generations WHERE operator_id=$1',
    [owner.operatorId])).rows[0].count,2);
  for (const tenant of [...first.tenants,...next.tenants]) assert.equal(await tenantAudit.verifyTenantChain(tenant.tenantId),true);
  const snapshot=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM platform_sessions WHERE operator_id=$1) AS sessions,
    (SELECT count(*)::int FROM platform_audit_events) AS audit,
    (SELECT count(*)::int FROM synthetic_tenant_generations) AS generations,
    (SELECT count(*)::int FROM platform_passkey_auth_transactions WHERE operator_id=$1 AND consumed_at IS NOT NULL) AS proofs,
    (SELECT signature_counter FROM platform_passkey_credentials WHERE credential_id=$2) AS counter`,
  [failed.operatorId,failed.keys[0].credential.id])).rows[0];
  const before=await snapshot();
  // Isolated test-only deferred failure occurs at actual outer COMMIT after the
  // real proof, archival/provisioning and audit work. No production fault hook.
  await pool.query(`CREATE FUNCTION synthetic_generation_http_test_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'SYNTHETIC_HTTP_TEST_COMMIT_DENIED';END $$`);
  await pool.query(`CREATE CONSTRAINT TRIGGER synthetic_generation_http_test_commit_failure AFTER INSERT ON synthetic_tenant_generations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_generation_http_test_commit_failure()`);
  try {
    const denied=await failure.replace({ expectedGenerationId: null,expectedRevision: 0 });assert.equal(denied.status,500);
    assert.equal(denied.headers['set-cookie'],undefined);assert.doesNotMatch(denied.text,/COMMIT_DENIED|SQL|private/);
    assert.deepEqual(await snapshot(),before);
    assert.ok(await failed.sessions.resolvePrincipal({ headers: { cookie: pair(failed.current().setCookie) } }));
  } finally {
    await pool.query('DROP TRIGGER synthetic_generation_http_test_commit_failure ON synthetic_tenant_generations');
    await pool.query('DROP FUNCTION synthetic_generation_http_test_commit_failure()');
  }
  const sensitive=[owner.operatorId,failed.operatorId,pair(created.headers['set-cookie'][0]).split('=')[1]];
  for (const value of sensitive) assert.equal(logs.join('').includes(value),false,'private actor/session values are never logged');
});

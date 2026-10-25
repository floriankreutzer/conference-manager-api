import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresSyntheticCalendarRepository } from '../src/persistence/postgres/synthetic-calendar-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createSyntheticCalendarProviderFactory } from '../src/integrations/synthetic-calendar-provider.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

test('native TLS max1 synthetic calendar persists idempotent create, reschedule, cancellation and reset history',
async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),pools=[];
  function database(url,max=1) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href,2),ownerLease=database(fixture.url.href);
  t.after(async()=>{ try { await Promise.all(pools.map(pool=>pool.end())); } finally { await fixture.destroy(); } });
  await migrateUp(pool);const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const passwords=['customer','platform'].map(()=>randomBytes(32).toString('hex'));
  for (const [index,surface] of ['customer','platform'].entries()) {
    assert.match(passwords[index],/^[a-f0-9]{64}$/);
    await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${passwords[index]}'`);
  }
  await grantProtectedRuntimeRoles(pool,scope);
  const owner=await createProtectedSyntheticOperatorFixture(pool,ownerLease,{ epoch });
  const service=createSyntheticGenerationService({ ...scope,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,{ ...scope,
      tenantAuditRepository: createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) }),
      platformAuditRepository: owner.auditRepository }) });
  async function replace(id=null,revision=0) {
    const intent={ operatorId: owner.operatorId,expectedGenerationId: id,expectedRevision: revision };
    return owner.execute(service.operationHash(intent),proofContext=>service.replace({ proofContext,intent,correlationId: randomUUID() }));
  }
  const generation=await replace(),tenantId=generation.tenants.find(row=>row.slot==='northwind').tenantId;
  const integrationId=randomUUID(),roomId=(await pool.query('SELECT id FROM rooms WHERE tenant_id=$1 ORDER BY id LIMIT 1',
    [tenantId])).rows[0].id;
  const requests=(await pool.query('SELECT id FROM requests WHERE tenant_id=$1 ORDER BY id LIMIT 3',[tenantId])).rows.map(row=>row.id);
  // Explicit fixture-only technical preparation. Owned generation activation
  // and final business authority are intentionally separate acceptance work.
  await pool.query(`INSERT INTO integrations(tenant_id,id,provider,provider_reference,status)
    VALUES($1,$2,'synthetic_calendar',$3,'active')`,[tenantId,integrationId,`synthetic:${generation.generationId}`]);
  await pool.query(`INSERT INTO synthetic_calendar_resources(environment,security_epoch,tenant_id,generation_id,integration_id,room_id)
    VALUES('int',$1,$2,$3,$4,$5)`,[epoch,tenantId,generation.generationId,integrationId,roomId]);
  const url=new URL(fixture.url);url.username='cm_protected_int_customer';url.password=passwords[0];
  function runtime() {
    const business=database(url.href),lease=database(url.href);
    const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...scope,pool: business,leasePool: lease });
    const repository=createPostgresSyntheticCalendarRepository(business,scope);
    return { business,scopes,factory: createSyntheticCalendarProviderFactory({ repository }) };
  }
  const first=runtime(),second=runtime();
  assert.equal((await first.business.query('SELECT session_user AS login')).rows[0].login,'cm_protected_int_customer');
  for (const query of ['UPDATE synthetic_calendar_resources SET revision=revision+1',
    'DELETE FROM synthetic_calendar_events','UPDATE platform_operators SET status=status']) {
    await assert.rejects(first.business.query(query),{ code: '42501' });
  }
  const bind=runtime=>runtime.scopes.withShared(()=>runtime.factory.forRoom({ tenantId,roomId }));
  const [a,b]=await Promise.all([bind(first),bind(second)]);
  assert.equal(a.integrationProvider,'synthetic_calendar');assert.equal(a.identityProvider,'platform_delegation');
  const input=(index=0,day='01')=>({ tenantId,roomId,requestId: requests[index],phase: 'final',correlationId: randomUUID(),
    startsAt: `2028-01-${day}T10:00:00.000Z`,endsAt: `2028-01-${day}T11:00:00.000Z` });
  const create=(index=0,day='01',key=randomBytes(32).toString('hex'))=>({ ...input(index,day),idempotencyKey: key,
    providerResourceReference: a.providerResourceReference });
  const operation=(runtime,provider,name,value)=>runtime.scopes.withShared(()=>provider[name](value));
  const prebooking=()=>{ const value=input(0);delete value.requestId;return value; };
  assert.deepEqual(await operation(first,a,'lookupAvailability',prebooking()),{ available: true,conflictCount: 0 });
  const shared=create();
  const repeated=await Promise.all([operation(first,a,'createCalendarEvent',shared),operation(second,b,'createCalendarEvent',shared)]);
  assert.deepEqual(repeated.map(row=>row.disposition).sort(),['created','existing']);
  assert.equal(repeated[0].providerReference,repeated[1].providerReference);
  assert.equal((await operation(first,a,'createCalendarEvent',shared)).disposition,'existing');
  assert.deepEqual(await operation(first,a,'lookupAvailability',input(1)),{ available: false,conflictCount: 1 });
  assert.deepEqual(await operation(first,a,'lookupAvailability',prebooking()),{ available: false,conflictCount: 1 });
  assert.deepEqual(await operation(first,a,'validateReservation',input(0)),{ valid: true,reason: 'available' });
  await assert.rejects(operation(second,b,'createCalendarEvent',create(1)),{ kind: 'conflict' });
  const event=repeated[0].providerReference;
  const change={ ...input(0,'02'),providerReference: event,providerResourceReference: a.providerResourceReference };
  assert.equal((await operation(first,a,'updateCalendarEvent',change)).disposition,'updated');
  assert.equal((await operation(first,a,'updateCalendarEvent',change)).disposition,'unchanged');
  assert.deepEqual(await operation(first,a,'lookupAvailability',input(1)),{ available: true,conflictCount: 0 });
  assert.deepEqual(await operation(first,a,'lookupAvailability',prebooking()),{ available: true,conflictCount: 0 });
  await operation(second,b,'createCalendarEvent',create(1));
  assert.equal((await operation(first,a,'cancelCalendarEvent',change)).disposition,'cancelled');
  assert.equal((await operation(first,a,'cancelCalendarEvent',change)).disposition,'already_cancelled');
  await assert.rejects(operation(first,a,'createCalendarEvent',shared),{ kind: 'duplicate' });
  await assert.rejects(operation(first,a,'cancelCalendarEvent',{ ...change,requestId: requests[2] }),{ kind: 'not_found' });
  await assert.rejects(first.scopes.withShared(()=>first.factory.forPersistedReference({ tenantId,roomId,integrationId,
    providerConnectionReference: a.providerConnectionReference,providerResourceReference: 'foreign-room' })),{ kind: 'authorization' });
  const retained=(await pool.query('SELECT id,state,revision,starts_at,ends_at FROM synthetic_calendar_events ORDER BY id')).rows;
  await new Promise(resolve=>setTimeout(resolve,10100));
  const reset=await replace(generation.generationId,generation.revision);assert.notEqual(reset.generationId,generation.generationId);
  await assert.rejects(operation(first,a,'lookupAvailability',input(1)),{ kind: 'authorization' });
  await assert.rejects(operation(first,a,'cancelCalendarEvent',change),{ kind: 'authorization' });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_calendar_resources')).rows[0].count,1);
  const after=(await pool.query('SELECT id,state,revision,starts_at,ends_at FROM synthetic_calendar_events ORDER BY id')).rows;
  assert.deepEqual(after,retained);
});

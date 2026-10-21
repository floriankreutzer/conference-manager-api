import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedTenantRuntimeRepository } from '../src/persistence/postgres/protected-tenant-runtime-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createProtectedCalendarProviderFactory } from '../src/integrations/protected-calendar-provider-factory.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }
// Actual PostgreSQL/current custody and signed generation; adapter callbacks are
// explicit network-free tripwires, not real Microsoft or a durable SIM calendar.
test('native max1 calendar selection retains its reset barrier, isolates mode and restricts inactive REAL cleanup to cancellation',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end(),control.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const real=randomUUID(),unknown=randomUUID();
  for (const id of [real,unknown]) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic calendar mode fixture','onboarding')",[id]);
  }
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const application=createSyntheticGenerationService({ ...scope,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,{ ...scope,
      tenantAuditRepository: createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) }),
      platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(application.operationHash(intent),proofContext=>application.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const synthetic=generation.tenants[0].tenantId;
  const room=(await pool.query('SELECT id FROM rooms WHERE tenant_id=$1 ORDER BY id LIMIT 1',[synthetic])).rows[0].id;
  const repository=createPostgresProtectedTenantRuntimeRepository(pool,{ ...scope,leasePool });
  const entered=deferred(),release=deferred(),calls=[];let hold=true;
  const integrationId=randomUUID();
  function factory(mode) {
    async function select(input) {
      calls.push([mode,'bind',input.tenantId]);
      return { integrationId,integrationProvider: mode==='real' ? 'microsoft365' : 'synthetic_calendar',
        identityProvider: mode==='real' ? 'microsoft_entra' : 'platform_delegation',
        providerConnectionReference: `connection:${mode}`,providerResourceReference: `resource:${mode}`,
        async lookupAvailability(argument) {
          calls.push([mode,'availability',argument.tenantId]);
          assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value,1);
          if (hold) { entered.resolve();await release.promise; }
          return { available: true,conflictCount: 0 };
        },
        async validateReservation() { return { valid: true,reason: 'available' }; },
        async createCalendarEvent() { assert.fail('NO_CREATE_BY_SELECTION_PROBE'); },
        async updateCalendarEvent() { assert.fail('NO_UPDATE_BY_SELECTION_PROBE'); },
        async cancelCalendarEvent(argument) {
          calls.push([mode,'cancel',argument.tenantId]);await pool.query('SELECT 1');
          return { providerReference: 'fixture-event',disposition: 'cancelled' };
        },
      };
    }
    return { forRoom: select,forPersistedReference: select };
  }
  const provider=createProtectedCalendarProviderFactory({ ...scope,runtimeRepository: repository,
    realFactory: factory('real'),syntheticFactory: factory('synthetic') });
  const bound=await provider.forRoom({ tenantId: synthetic,roomId: room });
  assert.equal(bound.integrationProvider,'synthetic_calendar');assert.deepEqual(calls,[['synthetic','bind',synthetic]]);
  const pending=bound.lookupAvailability({ tenantId: synthetic,roomId: room });
  await Promise.race([entered.promise,pending.then(()=>{ throw new Error('PROVIDER_CALLBACK_NOT_ENTERED'); })]);
  try { await assert.rejects(control.query("SELECT protected_runtime_acquire_exclusive('int')"),/PROTECTED_RUNTIME_BUSY/); }
  finally { hold=false;release.resolve(); }
  assert.deepEqual(await pending,{ available: true,conflictCount: 0 });
  await control.query("SELECT protected_runtime_acquire_exclusive('int')");
  await assert.rejects(provider.forRoom({ tenantId: unknown,roomId: 'room-1' }),/PROTECTED_TENANT_RUNTIME_DENIED/);
  const before=calls.length;
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[owner.operatorId]);
  await assert.rejects(bound.lookupAvailability({ tenantId: synthetic,roomId: room }),/PROTECTED_TENANT_RUNTIME_DENIED/);
  assert.equal(calls.length,before);
  const realBound=await provider.forRoom({ tenantId: real,roomId: 'real-room' });
  assert.equal(realBound.integrationProvider,'microsoft365');
  await pool.query(`UPDATE tenants SET status='suspended',lifecycle_revision=lifecycle_revision+1,
    updated_at=clock_timestamp() WHERE id=$1`,[real]);
  await assert.rejects(provider.forRoom({ tenantId: real,roomId: 'real-room' }),/PROTECTED_TENANT_RUNTIME_DENIED/);
  const cleanup=await provider.forPersistedReference({ tenantId: real,roomId: 'real-room',integrationId,
    providerConnectionReference: 'connection:real',providerResourceReference: 'resource:real' });
  await assert.rejects(cleanup.createCalendarEvent({ tenantId: real,roomId: 'real-room' }),/PROTECTED_TENANT_RUNTIME_DENIED/);
  await assert.rejects(cleanup.updateCalendarEvent({ tenantId: real,roomId: 'real-room' }),/PROTECTED_TENANT_RUNTIME_DENIED/);
  assert.deepEqual(await cleanup.cancelCalendarEvent({ tenantId: real,roomId: 'real-room' }),
    { providerReference: 'fixture-event',disposition: 'cancelled' });
  assert.equal(calls.filter(([mode,method])=>mode==='real' && method==='cancel').length,1);
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[randomUUID()]);
  const final=calls.length;
  await assert.rejects(cleanup.cancelCalendarEvent({ tenantId: real,roomId: 'real-room' }),/PROTECTED_RUNTIME_SCOPE_STALE/);
  assert.equal(calls.length,final);
});

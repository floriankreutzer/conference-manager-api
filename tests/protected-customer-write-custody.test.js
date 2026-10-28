import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedCustomerWriteCustody } from '../src/protected-customer-write-composition.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const epoch='82000000-0000-4000-8000-000000000001',tenant='82000000-0000-4000-8000-000000000002';
const user='82000000-0000-4000-8000-000000000003',member='82000000-0000-4000-8000-000000000004';
const generation='82000000-0000-4000-8000-000000000005',operator='82000000-0000-4000-8000-000000000006';
const principal={ tenantId: tenant,userId: user,providerIdentity: { provider: 'email_code',reference: member },
  ...tenantAuthorizationSnapshot(['employee']),session: { id: member,securityVersion: 1,
    issuedAt: '2026-10-27T12:00:00.000Z',expiresAt: '2026-10-27T13:00:00.000Z' } };
function fixture() {
  const calls=[],state={ allowed: true,session: true,lock: true,mode: 'synthetic',roles: [] };let held=false,connects=0;
  const client={ async query(input) {
    calls.push(input);
    if (input?.name==='protected-delivery-real-tenant-lock') return { rowCount: state.mode==='real' ? 1 : 0,rows: [] };
    if (input?.name==='protected-participant-principal-member') return { rowCount: 1,rows: [{ id: member }] };
    if (input?.name==='protected-synthetic-participant-scope') return { rowCount: 1,rows: [{ allowed: state.allowed }] };
    if (input?.name==='protected-customer-current-invited-access') return { rowCount: state.session ? 1 : 0,
      rows: [{ mode: state.mode,roles: state.roles,generation_id: generation,operator_id: operator,slot: 'northwind' }] };
    if (input?.name==='protected-participant-current-session-lock') return { rowCount: state.lock ? 1 : 0,rows: [{ id: user }] };
    return { rowCount: 1,rows: [] };
  },release() { held=false; } };
  const pool={ async connect() {
    assert.equal(held,false,'max-one business transaction must be joined');held=true;connects++;return client;
  },
    async query() { return { rowCount: 1,rows: [{ allowed: true }] }; } };
  const lease={ async query() { return { rowCount: 1,rows: [{ acquired: true }] }; },release() {} };
  const leasePool={ query: (...args)=>lease.query(...args),connect: async()=>lease };
  const protection={ environment: 'int',securityEpoch: epoch },syntheticScope={ ...protection,platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,...protection });
  const writes=createProtectedCustomerWriteCustody({ pool,...protection,syntheticScope,syntheticParticipantsEnabled: true });
  const run=work=>scopes.withShared(()=>writes.run(work));
  const mutate=()=>withPostgresTransaction(pool,async current=>{
    assert.equal(current,client);await current.query('BUSINESS_WRITE');return 'committed';
  });
  return { pool,client,writes,scopes,run,mutate,state,calls,connects: ()=>connects };
}

test('participant writes qualify the current source on the same client without recursively invoking their own precondition',async()=>{
  const f=fixture();
  assert.equal(await f.run(async()=>{ assert.deepEqual(await f.writes.observe(principal),principal);return f.mutate(); }),'committed');
  assert.equal(f.connects(),2,'one completed observation transaction and one business transaction');
  assert.equal(f.calls.filter(input=>input?.name==='protected-participant-current-session-lock').length,1);
  const lock=f.calls.findIndex(input=>input?.name==='protected-participant-current-session-lock');
  assert.ok(lock<f.calls.indexOf('BUSINESS_WRITE'));assert.equal(f.calls.at(-1),'COMMIT');
});

test('source loss, session revocation, role changes and lock contention after observation prevent any business mutation',async()=>{
  for (const change of [{ allowed: false },{ session: false },{ roles: ['tenant_admin'] },{ lock: false }]) {
    const f=fixture();
    await assert.rejects(f.run(async()=>{
      await f.writes.observe(principal);Object.assign(f.state,change);return f.mutate();
    }),/AUTHORIZATION_DENIED/);
    assert.equal(f.calls.includes('BUSINESS_WRITE'),false);assert.equal(f.calls.at(-1),'ROLLBACK');
  }
});

test('synthetic participants cannot reach any actual Microsoft365 network method or admin-consent redirect',async()=>{
  const f=fixture();let network=0;
  const call=()=>{ network++;return 'real'; },client={ redirectUri: 'https://app-int.example.test/callback',adminConsentUrl: call,
    discoverRooms: call,lookupFreeBusy: call,createCalendarEvent: call,updateCalendarEvent: call,cancelCalendarEvent: call,
    verifyBasePermissions: call };
  const provider=f.writes.providerClient(client);
  await f.run(async()=>{
    await f.writes.observe(principal);
    assert.throws(()=>provider.adminConsentUrl({}),/AUTHORIZATION_DENIED/);
    for (const name of Object.keys(client).filter(name=>!['redirectUri','adminConsentUrl'].includes(name))) {
      await assert.rejects(async()=>provider[name]({}),/AUTHORIZATION_DENIED/);
    }
  });
  assert.equal(network,0);
  f.state.mode='real';
  await f.run(async()=>{ await f.writes.observe(principal);assert.equal(await provider.discoverRooms({}),'real'); });
  assert.equal(network,1,'ordinary REAL membership retains its existing fixed provider path');
});

test('missing observation context and detached writes after the request ends cannot acquire transaction authority',async()=>{
  const f=fixture();await assert.rejects(f.writes.observe(principal),/AUTHORIZATION_DENIED/);assert.equal(f.calls.length,0);
  let release,detached;
  const pending=new Promise(resolve=>{ release=resolve; });
  await f.run(async()=>{
    await f.writes.observe(principal);detached=pending.then(()=>f.mutate());
  });
  release();await assert.rejects(detached,/AUTHORIZATION_DENIED/);assert.equal(f.calls.includes('BUSINESS_WRITE'),false);
});

test('the new pool-owned write composition is excluded from domain, HTTP, provider and closed Demo ownership',()=>{
  const root='src/protected-customer-write-composition.js';
  for (const source of ['src/domain/probe.js','src/application/probe.js','src/http/probe.js','src/integrations/probe.js',
    'src/demo/customer-main.js','src/demo/platform-main.js']) {
    assert.ok(moduleBoundaryViolations({ [source]: "import '../protected-customer-write-composition.js';",[root]: 'export const x=1;' })
      .length>0,source);
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPostgresBookingReferenceRepository } from '../src/persistence/postgres/booking-reference-repository.js';

const tenantId=randomUUID(),integrationId=randomUUID(),principal=Object.freeze({ marker: 'server-resolved-principal' });
const requestId='request-01',providerConnectionReference=`synthetic:${randomUUID()}`,providerResourceReference='synthetic-room:tenant:room';
const now=new Date('2028-01-01T00:00:00.000Z'),correlationId=randomUUID(),idempotencyKey='a'.repeat(64);
function fixture(guard=null) {
  const calls=[],state={ status: 'active',provider: 'synthetic_calendar' };
  const row={ tenant_id: tenantId,request_id: requestId,integration_id: integrationId,attempt_number: 1,provider_reference: null,
    provider_connection_reference: providerConnectionReference,provider_resource_reference: providerResourceReference,
    idempotency_key: idempotencyKey,state: 'pending',created_correlation_id: correlationId,created_at: now,updated_at: now };
  const client={ async query(input) {
    calls.push(input);
    if (input?.name==='booking-resource-binding-lock-eligible-request') return { rowCount: 1,rows: [{}] };
    if (input?.name==='booking-lock-current-create-authority') return { rowCount: 1,rows: [{
      provider: state.provider,status: state.status,provider_reference: providerConnectionReference }] };
    if (input?.name==='booking-reference-find-with-client') return { rowCount: 1,rows: [row] };
    if (typeof input==='object') assert.ok(['booking-reference-tenant-order-lock','booking-reference-lock'].includes(input.name));
    return { rowCount: 0,rows: [] };
  },release() {} };
  const pool={ query: client.query,async connect() { return client; } };
  const repository=createPostgresBookingReferenceRepository(pool,{ calendarAuthorityGuard: guard,
    auditRepository: { appendWithClient() { assert.fail('replay cannot append audit'); } } });
  return { calls,state,run: ()=>repository.reserveProviderResourceBinding({ tenantId,requestId,integrationId,principal,
    providerConnectionReference,providerResourceReference,idempotencyKey,correlationId,changedAt: now,auditEvent: {} }) };
}

test('truthful active synthetic binding requires its protected guard and exact server principal; connected is not a substitute',async()=>{
  const absent=fixture();await assert.rejects(absent.run(),{ name: 'BookingReferenceConflictError' });
  assert.equal(absent.calls.some(call=>call?.name==='booking-reference-find-with-client'),false);
  let allow=false,count=0;
  const guarded=fixture({ async lockBookingIntegration(client,input) {
    assert.equal(typeof client.query,'function');assert.deepEqual(input,{ tenantId,integrationId,providerConnectionReference,principal });
    count++;return allow;
  } });
  await assert.rejects(guarded.run(),{ name: 'BookingReferenceConflictError' });assert.equal(count,1);
  allow=true;const result=await guarded.run();assert.equal(result.created,false);assert.equal(result.reference.state,'pending');
  guarded.state.status='connected';await assert.rejects(guarded.run(),{ name: 'BookingReferenceConflictError' });
  assert.equal(count,2,'a fake connected state must not invoke or bypass protected authority');
  const ordinary=fixture();ordinary.state.provider='ordinary_provider';ordinary.state.status='connected';
  assert.equal((await ordinary.run()).created,false,'existing connected custom-provider behavior remains');
});

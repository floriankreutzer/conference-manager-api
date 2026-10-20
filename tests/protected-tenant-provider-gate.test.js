import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedTenantProviderGate } from '../src/tenancy/protected-tenant-provider-gate.js';
import { ProtectedTenantRuntimeError } from '../src/tenancy/protected-tenant-runtime.js';

const TENANT='c3000000-0000-4000-8000-000000000001',EPOCH='c3000000-0000-4000-8000-000000000002';
const OTHER='c3000000-0000-4000-8000-000000000003';
const context={ environment: 'int',securityEpoch: EPOCH,tenantId: TENANT };
const real={ ...context,mode: 'real',generationId: null,generationState: null,operatorId: null,slot: null };
const synthetic={ ...real,mode: 'synthetic',generationId: OTHER,generationState: 'active',operatorId: OTHER,slot: 'contoso' };

test('each provider attempt executes only inside current registry custody with a composition-fixed mode',async()=>{
  let locked=false,lookups=0,attempts=0,current=real;
  const repository={ async withCurrentTenantRuntime(scope,work) {
    assert.deepEqual(scope,context);lookups++;locked=true;try { return await work(current); } finally { locked=false; }
  } };
  const gate=createProtectedTenantProviderGate({ repository,...context,mode: 'real' });
  const operation=async runtime=>{ assert.equal(locked,true);assert.equal(runtime.mode,'real');attempts++;return 'provider-result'; };
  assert.equal(await gate.run(TENANT,operation),'provider-result');assert.equal(attempts,1);
  current=synthetic;await assert.rejects(gate.run(TENANT,operation),ProtectedTenantRuntimeError);
  assert.equal(lookups,2);assert.equal(attempts,1);assert.equal(locked,false);
});

test('foreign/unknown/archived/stale contexts never call a real adapter or fall back to simulation',async()=>{
  let attempts=0;
  for (const current of [null,{},synthetic,{ ...real,tenantId: OTHER },{ ...real,securityEpoch: OTHER },
    { ...real,environment: 'dev' },{ ...synthetic,generationState: 'archived' }]) {
    const gate=createProtectedTenantProviderGate({ ...context,mode: 'real',repository: {
      withCurrentTenantRuntime: async(scope,work)=>work(current),
    } });
    await assert.rejects(gate.run(TENANT,()=>{ attempts++; }),ProtectedTenantRuntimeError);
  }
  assert.equal(attempts,0);
});

test('synthetic adapter has the symmetric boundary; duplicate callbacks cannot replay an outbound operation',async()=>{
  let attempts=0;
  const gate=createProtectedTenantProviderGate({ ...context,mode: 'synthetic',repository: {
    async withCurrentTenantRuntime(scope,work) { await work(synthetic);return work(synthetic); },
  } });
  await assert.rejects(gate.run(TENANT,()=>{ attempts++; }),ProtectedTenantRuntimeError);assert.equal(attempts,1);
  const wrong=createProtectedTenantProviderGate({ ...context,mode: 'synthetic',repository: {
    withCurrentTenantRuntime: async(scope,work)=>work(real),
  } });
  await assert.rejects(wrong.run(TENANT,()=>{ attempts++; }),ProtectedTenantRuntimeError);assert.equal(attempts,1);
});

test('repository/provider failures propagate once and incomplete composition fails startup',async()=>{
  let reads=0,attempts=0;
  const repository={ async withCurrentTenantRuntime(scope,work) { reads++;return work(real); } };
  const options={ ...context,mode: 'real',repository },gate=createProtectedTenantProviderGate(options);
  await assert.rejects(gate.run(TENANT,()=>{ attempts++;throw new Error('PROVIDER_UNAVAILABLE'); }),/PROVIDER_UNAVAILABLE/);
  assert.equal(reads,1);assert.equal(attempts,1);
  await assert.rejects(gate.run('untrusted-tenant',()=>{ attempts++; }),ProtectedTenantRuntimeError);assert.equal(reads,1);
  for (const change of [{ environment: 'demo' },{ securityEpoch: undefined },{ mode: 'demo' },{ repository: {} },
    { environment: 'prod',mode: 'synthetic' }]) {
    assert.throws(()=>createProtectedTenantProviderGate({ ...options,...change }),/PROTECTED_PROVIDER_GATE_CONFIGURATION_INVALID/);
  }
});

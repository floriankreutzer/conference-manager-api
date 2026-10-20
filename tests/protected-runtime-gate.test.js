import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import test from 'node:test';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import {
  withProtectedRuntimeSharedGate,withProtectedRuntimeExclusiveGate,
} from '../src/persistence/postgres/protected-runtime-gate.js';

function fixture(acquired=true) {
  const queries=[],releases=[];let connections=0;
  const client={ async query(value) {
    const text=typeof value==='string' ? value : value.text;queries.push(value);
    return { rows: text.includes('pg_try_advisory') ? [{ acquired }] : [] };
  },release: error=>releases.push(error) };
  return { client,queries,releases,pool: { async connect() { connections++;return client; } },connections: ()=>connections };
}

test('protected runtime shared/exclusive locks use distinct fixed scopes and complete one transaction',async()=>{
  for (const [environment,index] of [['dev',1],['int',2],['prod',3]]) {
    const f=fixture();
    assert.equal(await withProtectedRuntimeSharedGate(f.pool,environment,async client=>client===f.client),true);
    const lock=f.queries.find(query=>typeof query==='object');
    assert.equal(lock.text,'SELECT pg_try_advisory_xact_lock_shared($1,$2) AS acquired');assert.deepEqual(lock.values,[740193,index]);
    assert.equal(f.queries.at(-1),'COMMIT');assert.deepEqual(f.releases,[undefined]);assert.equal(f.connections(),1);
  }
});

test('contention and failed work roll back without invoking/retrying forbidden work or weakening the error',async()=>{
  for (const acquired of [false,null,undefined,'true']) {
    const f=fixture(acquired);let attempts=0;
    // Explicitly avoid fixture's default argument for undefined/malformed rows.
    if (acquired===undefined) f.client.query=async value=>{ f.queries.push(value);return { rows: [] }; };
    await assert.rejects(withProtectedRuntimeExclusiveGate(f.pool,'int',async()=>{ attempts++; }),
      { code: 'PROTECTED_RUNTIME_BUSY' });
    assert.equal(attempts,0);assert.equal(f.connections(),1);assert.equal(f.queries.at(-1),'ROLLBACK');
    assert.equal(f.releases[0]?.message,'TRANSACTION_ABORTED');
  }
  const f=fixture(),failure=new Error('SYNTHETIC_BUSINESS_FAILURE');
  await assert.rejects(withProtectedRuntimeExclusiveGate(f.pool,'int',async()=>{ throw failure; }),error=>error===failure);
  assert.equal(f.queries.at(-1),'ROLLBACK');
});

test('only safe same-scope nesting joins the held lease; upgrades, foreign scope and unmarked transactions fail',async()=>{
  const f=fixture(),other=fixture();
  await withProtectedRuntimeSharedGate(f.pool,'int',async client=>{
    assert.equal(await withProtectedRuntimeSharedGate(f.pool,'int',async nested=>nested===client),true);
    await assert.rejects(withProtectedRuntimeExclusiveGate(f.pool,'int',async()=>null),{ code: 'PROTECTED_RUNTIME_GATE_SCOPE_INVALID' });
    await assert.rejects(withProtectedRuntimeSharedGate(f.pool,'dev',async()=>null),{ code: 'PROTECTED_RUNTIME_GATE_SCOPE_INVALID' });
    await assert.rejects(withProtectedRuntimeSharedGate(other.pool,'int',async()=>null),{ code: 'PROTECTED_RUNTIME_GATE_SCOPE_INVALID' });
  });
  assert.equal(f.connections(),1);assert.equal(other.connections(),0);
  await withProtectedRuntimeExclusiveGate(f.pool,'int',async client=>{
    assert.equal(await withProtectedRuntimeExclusiveGate(f.pool,'int',async nested=>nested===client),true);
    assert.equal(await withProtectedRuntimeSharedGate(f.pool,'int',async nested=>nested===client),true);
  });
  await assert.rejects(withPostgresTransaction(f.pool,()=>withProtectedRuntimeSharedGate(f.pool,'int',async()=>null)),
    { code: 'PROTECTED_RUNTIME_GATE_ORDER_INVALID' });
});

test('detached asynchronous descendants cannot reuse a released runtime lease or connection',async()=>{
  const f=fixture();let detached;
  await withProtectedRuntimeSharedGate(f.pool,'int',async()=>{
    detached=AsyncResource.bind(()=>withProtectedRuntimeSharedGate(f.pool,'int',async()=>assert.fail('RELEASED_LEASE_REUSED')));
  });
  await assert.rejects(detached(),{ code: 'PROTECTED_RUNTIME_GATE_SCOPE_INVALID' });assert.equal(f.connections(),1);
});

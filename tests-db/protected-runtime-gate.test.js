import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import {
  withProtectedRuntimeSharedGate,withProtectedRuntimeExclusiveGate,
} from '../src/persistence/postgres/protected-runtime-gate.js';

function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }

test('native protected runtime leases fence concurrent reset, preserve environment separation and release on rollback',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());
  const entered=deferred(),release=deferred();
  const reader=withProtectedRuntimeSharedGate(pool,'int',async client=>{
    entered.resolve();await release.promise;
    assert.equal((await client.query('SELECT 1 AS value')).rows[0].value,1);
  });
  await Promise.race([entered.promise,reader.then(()=>{ throw new Error('PROTECTED_READER_NOT_ENTERED'); })]);
  try {
    await assert.rejects(withProtectedRuntimeExclusiveGate(pool,'int',()=>assert.fail('RESET_MUST_NOT_RUN')),
      { code: 'PROTECTED_RUNTIME_BUSY' });
    assert.equal(await withProtectedRuntimeSharedGate(pool,'int',async()=> 'another-reader'),'another-reader');
    assert.equal(await withProtectedRuntimeExclusiveGate(pool,'dev',async()=> 'independent'),'independent');
  } finally { release.resolve();await reader; }
  await withProtectedRuntimeExclusiveGate(pool,'int',async client=>{
    assert.equal(await withProtectedRuntimeSharedGate(pool,'int',async nested=>nested===client),true);
    assert.equal(await withProtectedRuntimeExclusiveGate(pool,'int',async nested=>nested===client),true);
  });
  const resetting=deferred(),finishReset=deferred();
  const reset=withProtectedRuntimeExclusiveGate(pool,'int',async()=>{ resetting.resolve();await finishReset.promise; });
  await Promise.race([resetting.promise,reset.then(()=>{ throw new Error('PROTECTED_RESET_NOT_ENTERED'); })]);
  try {
    await assert.rejects(withProtectedRuntimeSharedGate(pool,'int',()=>assert.fail('BUSINESS_MUST_NOT_RUN')),
      { code: 'PROTECTED_RUNTIME_BUSY' });
  } finally { finishReset.resolve();await reset; }
  await assert.rejects(withProtectedRuntimeExclusiveGate(pool,'int',async()=>{ throw new Error('SYNTHETIC_ROLLBACK'); }),
    /SYNTHETIC_ROLLBACK/);
  assert.equal(await withProtectedRuntimeExclusiveGate(pool,'int',async()=> 'released'),'released');
  await assert.rejects(withProtectedRuntimeSharedGate(pool,'int',()=>withProtectedRuntimeExclusiveGate(pool,'int',async()=>null)),
    { code: 'PROTECTED_RUNTIME_GATE_SCOPE_INVALID' });
  await assert.rejects(withPostgresTransaction(pool,()=>withProtectedRuntimeSharedGate(pool,'int',async()=>null)),
    { code: 'PROTECTED_RUNTIME_GATE_ORDER_INVALID' });
});

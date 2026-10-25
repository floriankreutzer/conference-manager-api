import assert from 'node:assert/strict';
import test from 'node:test';
import { withPostgresTransaction,createPostgresTransactionAuthorityScope,isPostgresTransactionActive }
  from '../src/persistence/postgres/transaction.js';

function fixture(check=async()=>true) {
  const events=[];
  const client={ query: async sql=>{ events.push(sql);return {}; },release: error=>events.push(error ? 'discard' : 'release') };
  const pool={ connect: async()=>client };
  const scope=createPostgresTransactionAuthorityScope(pool,{
    beforeWrite: async(connection,authority)=>{
      assert.equal(connection,client);assert.equal(isPostgresTransactionActive(pool,client),true);
      events.push(`guard:${authority.id}`);return check(connection,authority);
    },denied: ()=>new Error('AUTHORITY_DENIED'),
  });
  return { pool,client,events,scope };
}
const first=Object.freeze({ id: 'first' }),second=Object.freeze({ id: 'second' });

test('owned authority is checked before business work once per actual transaction, including reused max-one clients',async()=>{
  const f=fixture();
  await f.scope.run(async()=>{
    f.scope.admit(first,'first');f.scope.admit(Object.freeze({ id: 'first' }),'first');
    for (let index=0;index<2;index++) await withPostgresTransaction(f.pool,async client=>{
      f.events.push('business');await withPostgresTransaction(f.pool,async nested=>{ assert.equal(nested,client); });
    });
  });
  assert.deepEqual(f.events,[
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',"SET LOCAL TIME ZONE 'UTC'",'guard:first','business','COMMIT','release',
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',"SET LOCAL TIME ZONE 'UTC'",'guard:first','business','COMMIT','release',
  ]);
});

test('unregistered, unadmitted and read-only work preserve the existing path without a policy call',async()=>{
  const f=fixture(async()=>{ throw new Error('UNEXPECTED_GUARD'); });
  await withPostgresTransaction(f.pool,async()=>true);
  await f.scope.run(()=>withPostgresTransaction(f.pool,async()=>true));
  await f.scope.run(async()=>{
    f.scope.admit(first,'first');await withPostgresTransaction(f.pool,async()=>true,{ readOnly: true });
  });
  assert.equal(f.events.some(value=>value.startsWith('guard:')),false);
});

test('denied or unavailable current authority rolls back before work and is never rewritten as an infrastructure failure',async()=>{
  for (const result of [false,null,undefined,'true']) {
    const f=fixture(async()=>result);let work=false,mapper=false;
    await assert.rejects(f.scope.run(async()=>{
      f.scope.admit(first,'first');return withPostgresTransaction(f.pool,async()=>{ work=true; },{
        mapInfrastructureError() { mapper=true;return new Error('WRONG_MAPPING'); },
      });
    }),/AUTHORITY_DENIED/);
    assert.equal(work,false);assert.equal(mapper,false);assert.equal(f.events.includes('COMMIT'),false);
    assert.deepEqual(f.events.slice(-2),['ROLLBACK','discard']);
  }
  const unavailable=new Error('CURRENT_SOURCE_UNAVAILABLE'),f=fixture(async()=>{ throw unavailable; });
  await assert.rejects(f.scope.run(async()=>{
    f.scope.admit(first,'first');return withPostgresTransaction(f.pool,async()=>assert.fail());
  }),error=>error===unavailable);
});

test('parallel owned requests keep independent authority and nested owned work retains its original authority',async()=>{
  const f=fixture();
  await Promise.all([first,second].map(authority=>f.scope.run(async()=>{
    f.scope.admit(authority,authority.id);
    await f.scope.run(()=>withPostgresTransaction(f.pool,async()=>true));
  })));
  assert.deepEqual(f.events.filter(value=>value.startsWith('guard:')).sort(),['guard:first','guard:second']);
  await f.scope.run(async()=>{
    f.scope.admit(first,'first');
    assert.throws(()=>f.scope.admit(second,'second'),/AUTHORITY_DENIED/);
  });
});

test('authority cannot be admitted outside a live owned request, from mutable input or inside a business transaction',async()=>{
  const f=fixture();assert.throws(()=>f.scope.admit(first,'first'),/AUTHORITY_DENIED/);
  await f.scope.run(async()=>{
    for (const [authority,key] of [[{ id: 'mutable' },'first'],[first,''],[first,'x'.repeat(16385)]]) {
      assert.throws(()=>f.scope.admit(authority,key),/AUTHORITY_DENIED/);
    }
    await withPostgresTransaction(f.pool,async()=>{
      assert.throws(()=>f.scope.admit(first,'first'),/AUTHORITY_DENIED/);
    });
  });
  let escaped,release;
  const barrier=new Promise(resolve=>{ release=resolve; });
  await f.scope.run(async()=>{
    f.scope.admit(first,'first');
    escaped=barrier.then(()=>withPostgresTransaction(f.pool,async()=>assert.fail('ESCAPED_WORK')));
  });
  release();await assert.rejects(escaped,/AUTHORITY_DENIED/);
  assert.deepEqual(f.events.slice(-2),['ROLLBACK','discard']);
});

test('write precondition may join read-only current custody but may not recursively execute another write',async()=>{
  let f;
  f=fixture(async()=>{
    assert.equal(await withPostgresTransaction(f.pool,async()=>true,{ readOnly: true }),true);
    await assert.rejects(withPostgresTransaction(f.pool,async()=>assert.fail()),/AUTHORITY_DENIED/);
    return true;
  });
  await f.scope.run(async()=>{
    f.scope.admit(first,'first');await withPostgresTransaction(f.pool,async()=>f.events.push('business'));
  });
  assert.equal(f.events.filter(value=>value==='business').length,1);
});

test('registration is unique per actual pool and invalid policy ports fail closed',()=>{
  const f=fixture();
  assert.throws(()=>createPostgresTransactionAuthorityScope(f.pool,{ beforeWrite: async()=>true,denied: ()=>new Error() }),
    /CONFIGURATION_INVALID/);
  for (const changes of [{ beforeWrite: null },{ denied: null }]) {
    assert.throws(()=>createPostgresTransactionAuthorityScope({ connect() {} },{ beforeWrite: async()=>true,
      denied: ()=>new Error(),...changes }),/CONFIGURATION_INVALID/);
  }
});

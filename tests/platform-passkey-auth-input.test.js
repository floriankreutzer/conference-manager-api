import assert from 'node:assert/strict';
import test from 'node:test';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';
import { createPostgresPlatformPasskeyAuthRepository } from '../src/persistence/postgres/platform-passkey-auth-repository.js';

const ID = '11111111-1111-4111-8111-111111111111';
const record = () => ({ id: ID, operatorId: ID, operatorSecurityVersion: 1, environment: 'int', securityEpoch: 7,
  purpose: 'login', expectedSessionId: null, operationHash: null, correlationId: ID, ttlSeconds: 120,
  stateHash: 'a'.repeat(64), browserHash: 'b'.repeat(64), challenge: Buffer.alloc(32, 1).toString('base64url') });

test('invalid passkey creation authority and unknown fields fail before acquiring a database connection', async () => {
  let connections = 0;
  const repository = createPostgresPlatformPasskeyAuthRepository({ async connect() { connections += 1; throw new Error('DB'); },
      query() { throw new Error('DB'); } },
    { auditRepository: { appendWithClient() {} }, verifier: { verifyAuthentication() {} } });
  for (const change of [{ operatorId: 'foreign' }, { operatorSecurityVersion: 0 }, { environment: 'demo' }, { securityEpoch: 0 },
    { purpose: 'register' }, { expectedSessionId: ID }, { operationHash: 'a'.repeat(64) }, { roles: ['platform_security_admin'] },
    { ttlSeconds: 59 }, { ttlSeconds: 301 }, { browserHash: 'raw-browser-secret' }, { stateHash: 'x'.repeat(64) },
    { challenge: 'a='.repeat(32) }, { correlationId: null }, { challenge: `${'a'.repeat(42)}B` },
    { purpose: 'step_up', expectedSessionId: ID, operationHash: null }]) {
    await assert.rejects(repository.create({ ...record(), ...change }), /PLATFORM_PASSKEY_/);
  }
  assert.equal(connections, 0);
});

test('passkey authentication requires exact binding and mandatory transactional session mutation', async () => {
  let connections = 0;
  const repository = createPostgresPlatformPasskeyAuthRepository({ async connect() { connections += 1; throw new Error('DB'); },
      query() { throw new Error('DB'); } },
    { auditRepository: { appendWithClient() {} }, verifier: { verifyAuthentication() {} } });
  const { id, correlationId, ttlSeconds, challenge, ...request } = record();
  for (const value of [{ ...request, response: {}, userId: ID }, { ...request, response: {}, securityEpoch: -1 },
    { ...request, response: {}, purpose: 'step_up', expectedSessionId: null }]) {
    await assert.rejects(repository.authenticate(value, () => true), /PLATFORM_PASSKEY_/);
  }
  await assert.rejects(repository.authenticate({ ...request, response: {} }), /PLATFORM_PASSKEY_TRANSACTION_INVALID/);
  assert.equal(connections, 0);
});

test('both Demo surfaces reject transitive access to real passkey authentication persistence', () => {
  for (const surface of ['customer', 'platform']) {
    const violations = architectureConsolidationBoundaryViolations({
      [`src/demo/${surface}-composition.js`]: "import '../integrations/proxy.js';",
      'src/integrations/proxy.js': "import '../persistence/postgres/platform-passkey-auth-repository.js';",
      'src/persistence/postgres/platform-passkey-auth-repository.js': 'export const repository = true;',
    });
    assert.ok(violations.some(value => value.includes('must not reach real Platform passkey')));
  }
});

test('step-up opens a writable coherent snapshot without changing ordinary login isolation', async () => {
  for (const purpose of ['login', 'step_up']) {
    const queries=[];
    const pool={ query() { throw new Error('UNEXPECTED_POOL_QUERY'); },async connect() {
      return { async query(query) {
        queries.push(typeof query==='string' ? query : query.name);
        return { rowCount: 0,rows: [] };
      },release() {} };
    } };
    const repository=createPostgresPlatformPasskeyAuthRepository(pool,
      { auditRepository: { appendWithClient() {} },verifier: { verifyAuthentication() {} } });
    const { id,correlationId,ttlSeconds,challenge,...request }=record();
    assert.equal(await repository.authenticate({ ...request,purpose,response: {},
      ...(purpose==='step_up' ? { expectedSessionId: ID,operationHash: 'd'.repeat(64) } : {}) },
    () => { throw new Error('UNVERIFIED_CALLBACK'); }),null);
    assert.equal(queries[0],`BEGIN ISOLATION LEVEL ${purpose==='step_up' ? 'REPEATABLE READ' : 'READ COMMITTED'} READ WRITE`);
    assert.ok(queries.includes('COMMIT'));
  }
});

test('an explicit step-up transaction scope surrounds proof locking; ordinary login never enters it',async()=>{
  for (const purpose of ['login','step_up']) {
    const events=[];
    const pool={ query() { throw new Error('UNEXPECTED_POOL_QUERY'); },async connect() {
      events.push('connect');return { async query(input) {
        events.push(typeof input==='string' ? input : input.name);return { rowCount: 0,rows: [] };
      },release() { events.push('release'); } };
    } };
    const repository=createPostgresPlatformPasskeyAuthRepository(pool,{ auditRepository: { appendWithClient() {} },
      verifier: { verifyAuthentication() {} },stepUpTransaction: async(scope,work)=>{
        assert.deepEqual(scope,{ operatorId: ID,operatorSecurityVersion: 1 });assert.equal(Object.isFrozen(scope),true);
        events.push('scope-enter');const result=await work();events.push('scope-exit');return result;
      } });
    const { id,correlationId,ttlSeconds,challenge,...request }=record();
    assert.equal(await repository.authenticate({ ...request,purpose,response: {},
      ...(purpose==='step_up' ? { expectedSessionId: ID,operationHash: 'd'.repeat(64) } : {}) },()=>assert.fail('UNVERIFIED')),null);
    assert.equal(events[0],purpose==='step_up' ? 'scope-enter' : 'connect');
    assert.equal(events.at(-1),purpose==='step_up' ? 'scope-exit' : 'release');
  }
});

test('step-up scope cannot fabricate a result, skip/double proof work or fall back after a scope failure',async()=>{
  for (const scenario of ['skip','double','transform','failure']) {
    let connections=0;
    const pool={ query() { throw new Error('UNEXPECTED_POOL_QUERY'); },async connect() {
      connections++;return { async query() { return { rowCount: 0,rows: [] }; },release() {} };
    } };
    const repository=createPostgresPlatformPasskeyAuthRepository(pool,{ auditRepository: { appendWithClient() {} },
      verifier: { verifyAuthentication() {} },stepUpTransaction: async(scope,work)=>{
        if (scenario==='skip') return { forged: true };
        if (scenario==='failure') throw new Error('SYNTHETIC_SCOPE_FAILED');
        await work();return scenario==='double' ? work() : { forged: true };
      } });
    const { id,correlationId,ttlSeconds,challenge,...request }=record();
    await assert.rejects(repository.authenticate({ ...request,purpose: 'step_up',expectedSessionId: ID,
      operationHash: 'e'.repeat(64),response: {} },()=>assert.fail('UNVERIFIED_CALLBACK')),
    scenario==='failure' ? /SYNTHETIC_SCOPE_FAILED/ : /TRANSACTION_SCOPE_INVALID/);
    assert.equal(connections,scenario==='skip' || scenario==='failure' ? 0 : 1);
  }
});

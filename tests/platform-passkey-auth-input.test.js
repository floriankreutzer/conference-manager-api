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
  const repository = createPostgresPlatformPasskeyAuthRepository({ async connect() { connections += 1; throw new Error('DB'); } },
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
  const repository = createPostgresPlatformPasskeyAuthRepository({ async connect() { connections += 1; throw new Error('DB'); } },
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

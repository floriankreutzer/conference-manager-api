import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMO_FIXTURE,
  DEMO_FIXTURE_CHECKSUM,
} from '../src/demo/fixture.js';
import { createDemoResetService } from '../src/demo/reset-service.js';
import { createDemoPlatformControlRoutes } from '../src/demo/http/platform-control-routes.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import {
  PLATFORM_ROLE,
  permissionsForPlatformRoles,
} from '../src/platform/identity/policy.js';
import {
  DEMO_RESET_FAILURE_REASON,
  DEMO_RESET_TABLES,
  DemoResetRepositoryError,
  createPostgresDemoResetRepository,
} from '../src/persistence/postgres/demo-reset-repository.js';

const META_TABLES = Object.freeze([
  'schema_migrations',
  'demo_schema_migrations',
  'demo_database_sentinel',
]);

function validSentinel(overrides = {}) {
  return {
    sentinel_key: 'conference-manager-shared-demo-v1',
    runtime_schema_version: 1,
    database_name: 'conference_manager_demo_test',
    customer_role: 'demo_customer',
    platform_role: 'demo_platform',
    reset_role: 'demo_reset',
    current_database: 'conference_manager_demo_test',
    current_role: 'demo_reset',
    production_schema_versions: Array.from({ length: 33 }, (_, index) => index + 1),
    ...overrides,
  };
}

function createFakePool({
  sentinel = validSentinel(),
  sentinelRowCount = 1,
  authorityResults = null,
} = {}) {
  const queries = [];
  const waiters = [];
  let exclusiveHeld = false;

  async function lock() {
    if (!exclusiveHeld) {
      exclusiveHeld = true;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    exclusiveHeld = true;
  }

  function unlock() {
    exclusiveHeld = false;
    waiters.shift()?.();
  }

  return {
    queries,
    async connect() {
      return {
        async query(query, values) {
          const text = typeof query === 'string' ? query : query.text;
          queries.push({ name: query?.name, text, values: query?.values || values });
          if (text === 'SELECT pg_advisory_lock($1)') {
            await lock();
            return { rows: [] };
          }
          if (text === 'SELECT pg_advisory_unlock($1)') {
            unlock();
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          if (query?.name === 'demo-reset-sentinel') {
            return { rowCount: sentinelRowCount, rows: sentinelRowCount === 1 ? [sentinel] : [] };
          }
          if (query?.name === 'demo-reset-schema-inventory') {
            return {
              rows: [...DEMO_RESET_TABLES, ...META_TABLES].sort().map((tablename) => ({ tablename })),
            };
          }
          if (query?.name === 'demo-reset-authority-revalidation') {
            const allowed = authorityResults === null ? true : authorityResults.shift() === true;
            return { rowCount: allowed ? 1 : 0, rows: allowed ? [{ '?column?': 1 }] : [] };
          }
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
}

const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESET_ACTOR = Object.freeze({
  operatorId: OPERATOR_ID,
  roles: Object.freeze([PLATFORM_ROLE.SECURITY_ADMIN]),
  permissions: permissionsForPlatformRoles([PLATFORM_ROLE.SECURITY_ADMIN]),
  assuranceLevel: 'step_up',
});
const RESET_AUTHORITY = Object.freeze({
  operatorId: OPERATOR_ID,
  sessionId: SESSION_ID,
  securityVersion: 1,
});

function createAuditRepository() {
  const attempts = [];
  const transactional = [];
  return {
    attempts,
    transactional,
    async append(event) { attempts.push(event); },
    async appendWithClient(_client, event) { transactional.push(event); },
  };
}

function repository(pool, { seedBusinessState, readSemanticState, auditRepository = null } = {}) {
  return createPostgresDemoResetRepository({
    pool,
    expectedDatabaseName: 'conference_manager_demo_test',
    expectedResetRole: 'demo_reset',
    auditRepository,
    seedBusinessState: seedBusinessState || (async () => {}),
    readSemanticState: readSemanticState || (async () => DEMO_FIXTURE),
  });
}

test('reset rejects a missing or wrong sentinel before destructive SQL', async () => {
  for (const pool of [
    createFakePool({ sentinelRowCount: 0 }),
    createFakePool({ sentinel: validSentinel({ sentinel_key: 'wrong-demo' }) }),
    createFakePool({ sentinel: validSentinel({ current_database: 'production' }) }),
    createFakePool({ sentinel: validSentinel({ current_role: 'postgres' }) }),
  ]) {
    await assert.rejects(
      repository(pool).reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM }),
      (error) => error instanceof DemoResetRepositoryError && error.code === 'DEMO_RESET_SENTINEL_INVALID',
    );
    assert.equal(pool.queries.some(({ name }) => name === 'demo-reset-truncate'), false);
  }
});

test('reset is atomic, reseeds deterministic state and returns an immutable seed descriptor', async () => {
  const pool = createFakePool();
  const auditRepository = createAuditRepository();
  let seeded = 0;
  const result = await repository(pool, {
    auditRepository,
    async seedBusinessState({ fixture }) {
      seeded += 1;
      assert.equal(fixture, DEMO_FIXTURE);
    },
  }).reset({
    fixture: DEMO_FIXTURE,
    checksum: DEMO_FIXTURE_CHECKSUM,
    authority: RESET_AUTHORITY,
    auditEventFor: ({ outcome }) => ({ outcome }),
  });
  assert.deepEqual(result, {
    seedVersion: 'saas-3.5-shared-demo-v1',
    checksum: DEMO_FIXTURE_CHECKSUM,
  });
  assert.equal(seeded, 1);
  assert.equal(Object.isFrozen(result), true);
  const names = pool.queries.map(({ name }) => name).filter(Boolean);
  assert.ok(names.indexOf('demo-reset-sentinel') < names.indexOf('demo-reset-truncate'));
  assert.ok(names.indexOf('demo-reset-truncate') < names.indexOf('demo-reset-insert-provider-simulation'));
  const truncate = pool.queries.find(({ name }) => name === 'demo-reset-truncate').text;
  assert.doesNotMatch(truncate, /RESTART\s+IDENTITY/i);
  const authorityQuery = pool.queries.find(
    ({ name }) => name === 'demo-reset-authority-revalidation',
  ).text;
  assert.match(authorityQuery, /platform_session\.principal_version = \$3/);
  assert.match(authorityQuery, /platform_session\.revoked_at IS NULL/);
  assert.equal(auditRepository.transactional.length, 1);
  assert.deepEqual(auditRepository.transactional[0], { outcome: 'success' });
  assert.equal(auditRepository.attempts.length, 0);
  assert.equal(pool.queries.some(({ text }) => text === 'COMMIT'), true);
});

test('exclusive Demo gate serializes concurrent resets', async () => {
  const pool = createFakePool();
  let activeSeeds = 0;
  let maximumActiveSeeds = 0;
  const resetRepository = repository(pool, {
    async seedBusinessState() {
      activeSeeds += 1;
      maximumActiveSeeds = Math.max(maximumActiveSeeds, activeSeeds);
      await new Promise((resolve) => setImmediate(resolve));
      activeSeeds -= 1;
    },
  });
  const results = await Promise.all([
    resetRepository.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM }),
    resetRepository.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM }),
  ]);
  assert.equal(maximumActiveSeeds, 1);
  assert.deepEqual(results.map(({ seedVersion }) => seedVersion), [
    'saas-3.5-shared-demo-v1',
    'saas-3.5-shared-demo-v1',
  ]);
  assert.equal(results.every(({ checksum }) => checksum === DEMO_FIXTURE_CHECKSUM), true);
});

test('a queued reset revalidates its concrete session under the exclusive gate', async () => {
  const pool = createFakePool({ authorityResults: [true, false] });
  const auditRepository = createAuditRepository();
  const resetRepository = repository(pool, { auditRepository });
  const input = {
    fixture: DEMO_FIXTURE,
    checksum: DEMO_FIXTURE_CHECKSUM,
    authority: RESET_AUTHORITY,
    auditEventFor: ({ outcome, reasonCode }) => ({ outcome, reasonCode }),
  };
  const results = await Promise.allSettled([
    resetRepository.reset(input),
    resetRepository.reset(input),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = results.find(({ status }) => status === 'rejected');
  assert.equal(rejection.reason.code, 'DEMO_RESET_AUTHORITY_REVOKED');
  assert.equal(
    pool.queries.filter(({ name }) => name === 'demo-reset-authority-revalidation').length,
    2,
  );
  assert.equal(pool.queries.filter(({ name }) => name === 'demo-reset-truncate').length, 1);
});

test('semantic projection mismatch rolls the transaction back', async () => {
  const pool = createFakePool();
  const auditRepository = createAuditRepository();
  await assert.rejects(
    repository(pool, {
      auditRepository,
      async readSemanticState() {
        return { unexpected: true };
      },
    }).reset({
      fixture: DEMO_FIXTURE,
      checksum: DEMO_FIXTURE_CHECKSUM,
      authority: RESET_AUTHORITY,
      auditEventFor: ({ outcome, reasonCode }) => ({ outcome, reasonCode }),
    }),
    (error) => error.code === 'DEMO_RESET_SEMANTIC_CHECKSUM_MISMATCH',
  );
  assert.equal(pool.queries.some(({ text }) => text === 'ROLLBACK'), true);
  assert.equal(pool.queries.some(({ text }) => text === 'COMMIT'), false);
  assert.deepEqual(auditRepository.attempts, [{
    outcome: 'failure',
    reasonCode: DEMO_RESET_FAILURE_REASON.SEMANTIC_CHECKSUM,
  }]);
});

test('success audit append failure rolls reset back and records only bounded failure evidence', async () => {
  const pool = createFakePool();
  const auditRepository = createAuditRepository();
  auditRepository.appendWithClient = async () => {
    throw new Error('simulated audit persistence failure');
  };
  await assert.rejects(
    repository(pool, { auditRepository }).reset({
      fixture: DEMO_FIXTURE,
      checksum: DEMO_FIXTURE_CHECKSUM,
      authority: RESET_AUTHORITY,
      auditEventFor: ({ outcome, reasonCode }) => ({ outcome, reasonCode }),
    }),
    /simulated audit persistence failure/,
  );
  assert.equal(pool.queries.some(({ text }) => text === 'ROLLBACK'), true);
  assert.equal(pool.queries.some(({ text }) => text === 'COMMIT'), false);
  assert.deepEqual(auditRepository.attempts, [{
    outcome: 'failure',
    reasonCode: DEMO_RESET_FAILURE_REASON.SUCCESS_AUDIT,
  }]);
});

test('reset service pins the source fixture checksum and validates repository output', async () => {
  const calls = [];
  const service = createDemoResetService({
    repository: {
      async recordAttempt() {},
      async reset(input) {
        calls.push(input);
        return {
          seedVersion: input.fixture.seedVersion,
          checksum: input.checksum,
        };
      },
    },
  });
  await assert.rejects(
    service.reset({ expectedChecksum: '0'.repeat(64) }),
    (error) => error.code === 'DEMO_RESET_CONFIRMATION_CHECKSUM_MISMATCH',
  );
  const result = await service.reset();
  assert.deepEqual(result, {
    seedVersion: 'saas-3.5-shared-demo-v1',
    checksum: DEMO_FIXTURE_CHECKSUM,
  });
  assert.equal(calls.length, 1);
});

test('reset service validates the minimized actor and creates bounded correlated audit events', async () => {
  let auditEventFor;
  const attempts = [];
  const service = createDemoResetService({
    repository: {
      async recordAttempt(event) { attempts.push(event); },
      async reset(input) {
        auditEventFor = input.auditEventFor;
        return { seedVersion: input.fixture.seedVersion, checksum: input.checksum };
      },
    },
  });

  await assert.rejects(
    service.reset({
      actor: { ...RESET_ACTOR, sessionId: 'forbidden' },
      authority: RESET_AUTHORITY,
      correlationId: CORRELATION_ID,
      auditEventFor() {},
    }),
    /DEMO_RESET_ACTOR_INVALID/,
  );
  await service.reset({
    actor: RESET_ACTOR,
    authority: RESET_AUTHORITY,
    correlationId: CORRELATION_ID,
    auditEventFor(input) {
      attempts.push(input);
      return input;
    },
  });
  const success = auditEventFor({ outcome: 'success', reasonCode: null });
  assert.deepEqual(success.actor, RESET_ACTOR);
  assert.equal(success.correlationId, CORRELATION_ID);
  assert.equal(success.seedVersion, DEMO_FIXTURE.seedVersion);
  assert.equal(Object.hasOwn(success.actor, 'session'), false);
});

function jsonRequest(body) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(payload.byteLength),
    },
    async *[Symbol.asyncIterator]() { yield payload; },
  };
}

function responseCapture() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(name, value); },
    end(body) { this.body = body; },
  };
}

test('Platform reset route passes only minimized authenticated actor authority', async () => {
  const calls = [];
  const principal = {
    operatorId: OPERATOR_ID,
    roles: [PLATFORM_ROLE.SECURITY_ADMIN],
    permissions: permissionsForPlatformRoles([PLATFORM_ROLE.SECURITY_ADMIN]),
    assurance: { level: 'step_up' },
    securityVersion: 1,
    session: { id: SESSION_ID },
  };
  const module = createDemoPlatformControlRoutes({
    personaService: { async establish() {}, async switch() {} },
    resetService: {
      async reset(input) {
        calls.push(input);
        return { seedVersion: DEMO_FIXTURE.seedVersion, checksum: DEMO_FIXTURE_CHECKSUM };
      },
    },
    authorizationPolicy: { authorize() { return true; } },
  });
  const handler = module.createHandler({
    platformPrincipalGuard: { async require() { return principal; } },
    platformSessionService: {
      clearCookie() {
        return 'cm_platform_session=; Path=/api/v1/platform; HttpOnly; Secure; SameSite=Strict';
      },
    },
    maxBodyBytes: 1024,
    maxResponseBytes: 4096,
  });
  await handler({
    request: jsonRequest({ confirm: true }),
    response: responseCapture(),
    parsedUrl: new URL('https://platform.demo.invalid/api/v1/platform/demo/reset'),
    path: '/api/v1/platform/demo/reset',
    requestId: CORRELATION_ID,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actor, RESET_ACTOR);
  assert.deepEqual(calls[0].authority, RESET_AUTHORITY);
  assert.equal(calls[0].correlationId, CORRELATION_ID);
  assert.equal(typeof calls[0].auditEventFor, 'function');
  const success = calls[0].auditEventFor({
    actor: calls[0].actor,
    correlationId: calls[0].correlationId,
    outcome: 'success',
    reasonCode: null,
    seedVersion: DEMO_FIXTURE.seedVersion,
  });
  assert.equal(success.action, 'platform.recovery.executed');
  assert.equal(success.outcome, 'success');
  assert.equal(Object.hasOwn(success, 'session'), false);
});

test('Platform reset route records a bounded denial before rejecting missing recovery authority', async () => {
  const denials = [];
  const principal = {
    operatorId: OPERATOR_ID,
    roles: [PLATFORM_ROLE.SECURITY_ADMIN],
    permissions: permissionsForPlatformRoles([PLATFORM_ROLE.SECURITY_ADMIN]),
    assurance: { level: 'step_up' },
    securityVersion: 1,
    session: { id: SESSION_ID },
  };
  const module = createDemoPlatformControlRoutes({
    personaService: { async establish() {}, async switch() {} },
    resetService: {
      descriptor: { seedVersion: DEMO_FIXTURE.seedVersion },
      async reset() { assert.fail('reset must not run'); },
    },
    authorizationPolicy: { authorize() { throw new PlatformAuthorizationError(); } },
  });
  const handler = module.createHandler({
    platformPrincipalGuard: { async require() { return principal; } },
    platformAuditService: { async record(event) { denials.push(event); } },
    platformSessionService: { clearCookie() { return ''; } },
    maxBodyBytes: 1024,
    maxResponseBytes: 4096,
  });
  await assert.rejects(
    handler({
      request: jsonRequest({ confirm: true }),
      response: responseCapture(),
      parsedUrl: new URL('https://platform.demo.invalid/api/v1/platform/demo/reset'),
      path: '/api/v1/platform/demo/reset',
      requestId: CORRELATION_ID,
    }),
    PlatformAuthorizationError,
  );
  assert.equal(denials.length, 1);
  assert.equal(denials[0].operatorId, OPERATOR_ID);
  assert.equal(denials[0].correlationId, CORRELATION_ID);
  assert.equal(denials[0].action, 'platform.authorization.denied');
  assert.equal(denials[0].outcome, 'denied');
  assert.deepEqual(denials[0].metadata, {
    operation: 'reset',
    reasonCode: 'permission_denied',
  });
});

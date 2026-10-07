import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMO_FIXTURE,
  DEMO_FIXTURE_CHECKSUM,
} from '../src/demo/fixture.js';
import {
  DEMO_RESET_FAILURE_REASON,
  DEMO_RESET_TABLES,
  createPostgresDemoResetRepository,
} from '../src/persistence/postgres/demo-reset-repository.js';

const OPERATOR_ID = '31000000-0000-4000-8000-000000000004';
const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const META_TABLES = Object.freeze([
  'schema_migrations',
  'demo_schema_migrations',
  'demo_database_sentinel',
  'media_object_inventory',
]);
const RESET_AUTHORITY = Object.freeze({
  operatorId: OPERATOR_ID,
  sessionId: SESSION_ID,
  securityVersion: 1,
});

function fakeResetPool({ failQueryName = null, failCommit = false, failTransactionLock = false } = {}) {
  return {
    async connect() {
      return {
        async query(query) {
          const text = typeof query === 'string' ? query : query.text;
          const name = typeof query === 'object' ? query.name : null;
          if (failQueryName !== null && name === failQueryName) {
            throw new Error('sensitive-driver-detail-must-not-enter-audit');
          }
          if (text === 'SELECT pg_advisory_xact_lock($1)' && failTransactionLock) {
            throw new Error('sensitive-lock-detail-must-not-enter-audit');
          }
          if (text === 'COMMIT' && failCommit) {
            throw new Error('sensitive-commit-detail-must-not-enter-audit');
          }
          if (name === 'demo-reset-sentinel') {
            return {
              rowCount: 1,
              rows: [{
                sentinel_key: 'conference-manager-shared-demo-v1',
                runtime_schema_version: 1,
                database_name: 'conference_manager_demo_test',
                customer_role: 'demo_customer',
                platform_role: 'demo_platform',
                reset_role: 'demo_reset',
                current_database: 'conference_manager_demo_test',
                current_role: 'demo_reset',
                production_schema_versions: Array.from({ length: 44 }, (_, index) => index + 1),
              }],
            };
          }
          if (name === 'demo-reset-schema-inventory') {
            return {
              rowCount: DEMO_RESET_TABLES.length + META_TABLES.length,
              rows: [...DEMO_RESET_TABLES, ...META_TABLES]
                .sort()
                .map((tablename) => ({ tablename })),
            };
          }
          if (name === 'demo-reset-authority-revalidation') return { rowCount: 1, rows: [{ '?column?': 1 }] };
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
}

function auditRepository(attempts) {
  return {
    async append(event) { attempts.push(event); },
    async appendWithClient() {},
  };
}

function repositoryForPhase(pool, attempts) {
  let seededFixture = DEMO_FIXTURE;
  return createPostgresDemoResetRepository({
    pool,
    expectedDatabaseName: 'conference_manager_demo_test',
    expectedResetRole: 'demo_reset',
    auditRepository: auditRepository(attempts),
    async seedBusinessState({ fixture }) { seededFixture = fixture; },
    async readSemanticState() { return seededFixture; },
  });
}

function resetInput() {
  return {
    fixture: DEMO_FIXTURE,
    checksum: DEMO_FIXTURE_CHECKSUM,
    authority: RESET_AUTHORITY,
    auditEventFor: ({ outcome, reasonCode }) => ({ outcome, reasonCode }),
  };
}

test('Demo reset failure audit records only the closed failing phase', async () => {
  const attempts = [];
  const repository = repositoryForPhase(
    fakeResetPool({ failQueryName: 'demo-reset-truncate' }),
    attempts,
  );

  await assert.rejects(
    repository.reset(resetInput()),
    /sensitive-driver-detail-must-not-enter-audit/,
  );

  assert.deepEqual(attempts, [{
    outcome: 'failure',
    reasonCode: DEMO_RESET_FAILURE_REASON.TRUNCATE,
  }]);
  assert.doesNotMatch(JSON.stringify(attempts), /sensitive-driver-detail|password|sql/i);
});

test('Demo reset classifies commit failure as transaction evidence', async () => {
  const attempts = [];
  const repository = repositoryForPhase(fakeResetPool({ failCommit: true }), attempts);

  await assert.rejects(
    repository.reset(resetInput()),
    /sensitive-commit-detail-must-not-enter-audit/,
  );

  assert.deepEqual(attempts, [{
    outcome: 'failure',
    reasonCode: DEMO_RESET_FAILURE_REASON.TRANSACTION,
  }]);
  assert.doesNotMatch(JSON.stringify(attempts), /sensitive-commit-detail|password|sql/i);
});

test('Demo reset classifies transaction lock failure as transaction-lock evidence', async () => {
  const attempts = [];
  const repository = repositoryForPhase(fakeResetPool({ failTransactionLock: true }), attempts);

  await assert.rejects(
    repository.reset(resetInput()),
    /sensitive-lock-detail-must-not-enter-audit/,
  );

  assert.deepEqual(attempts, [{
    outcome: 'failure',
    reasonCode: DEMO_RESET_FAILURE_REASON.TRANSACTION_LOCK,
  }]);
  assert.doesNotMatch(JSON.stringify(attempts), /sensitive-lock-detail|password|sql/i);
});

test('Demo reset failure reasons remain a closed bounded taxonomy', () => {
  const reasons = Object.values(DEMO_RESET_FAILURE_REASON);
  assert.equal(new Set(reasons).size, reasons.length);
  assert.equal(reasons.length, 15);
  assert.equal(reasons.includes('media_registration_failed'), true);
  for (const reason of reasons) {
    assert.match(reason, /^[a-z][a-z0-9_]{2,31}$/);
  }
});

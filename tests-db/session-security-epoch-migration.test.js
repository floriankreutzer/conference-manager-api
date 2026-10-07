import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import {
  TENANT_ROLE,
  createAuthorizationPolicy,
  tenantAuthorizationSnapshot,
} from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  CURRENT_SCHEMA_VERSION,
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { migrateUp, rollbackToVersion } from './support/db-migrations.js';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_ID = '92929292-9292-4292-8292-929292929292';
const USER_ID = '93939393-9393-4393-8393-939393939393';
const LEGACY_SESSION_ID = '94949494-9494-4494-8494-949494949494';
const EPOCH_SESSION_ID = '95959595-9595-4595-8595-959595959595';
const CORRELATION_ID = '96969696-9696-4696-8696-969696969696';
const LEGACY_TOKEN = 'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL';
const EPOCH_TOKEN = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
const AUDIT_KEY = 'session-epoch-migration-audit-key';
const CSRF_KEY = 'session-epoch-migration-csrf-key-1';
const NOW = new Date('2026-09-01T12:00:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0];
}

async function clean(pool) {
  await pool.query('DELETE FROM sessions WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await removeSaas2TenantAdministrationFixtures(pool, [TENANT_ID]);
  await pool.query('DELETE FROM users WHERE tenant_id = $1', [TENANT_ID]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

test('migration 034 prevents legacy Customer-session resurrection across rollback and forward', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await clean(pool);
  assert.equal(CURRENT_SCHEMA_VERSION, 43);
  assert.equal(await rollbackToVersion(pool, 34), true);
  assert.equal(await isPostgresSchemaReady(pool, 33), true);

  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Session Epoch Tenant', 'active', $2, $2)`,
    [TENANT_ID, NOW],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at)
     VALUES ($1, $2, 'Session Epoch User', $3, $3)`,
    [TENANT_ID, USER_ID, NOW],
  );
  const legacyHash = tokenHash(LEGACY_TOKEN);
  await pool.query({
    text: `
      INSERT INTO sessions (
        id, tenant_id, user_id, token_hash, provider, provider_identity_reference,
        roles, permissions, principal_version, issued_at, expires_at
      )
      VALUES (
        $1, $2, $3, $4, 'test_oidc', 'legacy-subject',
        ARRAY['employee']::text[], ARRAY['request:read', 'request:cancel']::text[],
        1, $5, $6
      )
    `,
    values: [
      LEGACY_SESSION_ID,
      TENANT_ID,
      USER_ID,
      legacyHash,
      new Date('2026-08-31T12:00:00.000Z'),
      new Date('2026-09-02T12:00:00.000Z'),
    ],
  });

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  assert.ok(await sessionRepository.resolveByTokenHash(legacyHash, NOW));

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const migrated = await pool.query(
    'SELECT revoked_at FROM sessions WHERE id = $1',
    [LEGACY_SESSION_ID],
  );
  assert.ok(migrated.rows[0].revoked_at);
  assert.equal(await sessionRepository.resolveByTokenHash(legacyHash, NOW), null);
  const migration = await pool.query(
    'SELECT name FROM schema_migrations WHERE version = 34',
  );
  assert.equal(migration.rows[0].name, 'customer_session_epoch_revocation');

  assert.equal(await rollbackToVersion(pool, 34), true);
  assert.equal(await isPostgresSchemaReady(pool, 33), true);
  const afterRollback = await pool.query(
    'SELECT revoked_at FROM sessions WHERE id = $1',
    [LEGACY_SESSION_ID],
  );
  assert.ok(afterRollback.rows[0].revoked_at);
  assert.equal(await sessionRepository.resolveByTokenHash(legacyHash, NOW), null);

  await migrateUp(pool);
  const authorizationPolicy = createAuthorizationPolicy();
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy,
  });
  const service = createSessionService({
    repository: sessionRepository,
    auditService,
    publicOrigin: 'https://conference.example',
    csrfSecret: CSRF_KEY,
    clock: () => NOW.getTime(),
    tokenFactory: () => EPOCH_TOKEN,
    idFactory: () => EPOCH_SESSION_ID,
  });
  const authorization = tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE]);
  const issued = await service.issue({
    tenantId: TENANT_ID,
    userId: USER_ID,
    providerIdentity: { provider: 'test_oidc', reference: 'epoch-subject' },
    securityVersion: 1,
    ...authorization,
  }, { correlationId: CORRELATION_ID });
  assert.ok(await service.resolvePrincipal({
    headers: { cookie: cookiePair(issued.setCookie) },
  }));

  const epochRow = await pool.query(
    'SELECT token_hash FROM sessions WHERE id = $1',
    [EPOCH_SESSION_ID],
  );
  assert.notEqual(epochRow.rows[0].token_hash, tokenHash(EPOCH_TOKEN));

  assert.equal(await rollbackToVersion(pool, 34), true);
  assert.equal(await isPostgresSchemaReady(pool, 33), true);
  assert.equal(
    await sessionRepository.resolveByTokenHash(tokenHash(EPOCH_TOKEN), NOW),
    null,
  );
});
